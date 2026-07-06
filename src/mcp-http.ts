import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateBearer, sendUnauthorized } from "./auth/oauth.js";
import { getUserSecret } from "./auth/secrets.js";
import type { ServeContext } from "./context.js";
import {
  attachGatewayTools,
  closeMountedGateways,
  mountUserGateways,
  type MountedGateway,
} from "./gateways.js";
import { HevyClient, registerHevyTools } from "./integrations/hevy.js";
import { sendJson } from "./http-util.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerOpenItemsTools } from "./tools/openitems.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerReadTools } from "./tools/read.js";
import { registerRoutineTools } from "./tools/routines.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTopicTools } from "./topics.js";
import { SERVER_INSTRUCTIONS, VERSION } from "./version.js";

/**
 * Streamable HTTP MCP endpoint (`/mcp`), multi-tenant: every MCP session is
 * bound at initialize time to the authenticated user's own coaching DB, and
 * later requests must present a token for that same user. The tool layer
 * itself stays user-agnostic — it only ever sees a DB handle.
 */

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  mounted: MountedGateway[];
};

export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly ctx: ServeContext) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = authenticateBearer(this.ctx, req);
    if (!auth) {
      sendUnauthorized(this.ctx, res);
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = this.sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      if (session.userId !== auth.userId) {
        sendJson(res, 403, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session belongs to a different user" },
          id: null,
        });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    // No session id: this must be a new initialize request.
    if (req.method !== "POST") {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing Mcp-Session-Id header" },
        id: null,
      });
      return;
    }

    const db = this.ctx.tenants.open(auth.userId);

    // User-attached upstream MCP servers connect first: their instructions
    // join the session instructions, their tools mount after the native ones.
    const mounted = await mountUserGateways(this.ctx, auth.userId);
    let instructions = SERVER_INSTRUCTIONS;
    for (const m of mounted) {
      if (m.instructions) {
        instructions += `\n\n## Connected server "${m.gateway.name}" (attached by the user)\n\n${m.instructions}`;
      }
    }

    const server = new McpServer({ name: "coaching-mcp", version: VERSION }, { instructions });
    registerReadTools(server, db);
    registerWriteTools(server, db);
    registerOpsTools(server, db);
    registerDeleteTools(server, db);
    registerOpenItemsTools(server, db);
    registerRoutineTools(server, db);
    registerTopicTools(server, this.ctx.cfg.seedDir);

    // Opt-in integrations: tools appear only for users who connected the
    // service on their account page — each user acts with their own key.
    const secretsKey = this.ctx.cfg.secretsKey;
    if (secretsKey) {
      const hevyKey = getUserSecret(this.ctx.authDb, secretsKey, auth.userId, "hevy_api_key");
      if (hevyKey) registerHevyTools(server, new HevyClient(hevyKey));
    }

    if (mounted.length > 0) {
      const { mountedTools } = attachGatewayTools(server, mounted, this.ctx.log);
      this.ctx.log(
        `mounted ${mountedTools} gateway tool(s) from ${mounted.length} server(s) for ${auth.userId}`,
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, { transport, server, userId: auth.userId, mounted });
        this.ctx.log(`mcp session ${sid} opened for ${auth.userId}`);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && this.sessions.delete(sid)) this.ctx.log(`mcp session ${sid} closed`);
      void closeMountedGateways(mounted);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  /** Tear down all sessions for one user (account deletion). */
  async closeUserSessions(userId: string): Promise<void> {
    for (const [sid, session] of this.sessions) {
      if (session.userId !== userId) continue;
      this.sessions.delete(sid);
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
      await closeMountedGateways(session.mounted);
    }
  }

  async closeAll(): Promise<void> {
    for (const [sid, session] of this.sessions) {
      this.sessions.delete(sid);
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
      await closeMountedGateways(session.mounted);
    }
  }
}
