import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createQuotaRequest, getUser } from "./auth/db.js";
import { authenticateBearer, sendUnauthorized } from "./auth/oauth.js";
import { getUserSecret } from "./auth/secrets.js";
import type { ServeContext } from "./context.js";
import {
  attachGatewayTools,
  closeMountedGateways,
  mountUserGateways,
  toolPrefix,
  type MountedGateway,
} from "./gateways.js";
import { HevyClient, registerHevyTools } from "./integrations/hevy.js";
import {
  IntervalsClient,
  parseIntervalsCredentials,
  registerIntervalsTools,
} from "./integrations/intervals.js";
import { sendJson } from "./http-util.js";
import {
  contentBytes,
  formatMb,
  MCP_BODY_MAX_BYTES,
  quotaBytesForUser,
  TELEGRAM_NOTIFY_PER_DAY,
  WRITES_PER_MINUTE,
  type WriteLimits,
} from "./quota.js";
import { RateLimiter } from "./ratelimit.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerEditTools } from "./tools/edit.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerOpenItemsTools } from "./tools/openitems.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerReadTools } from "./tools/read.js";
import { registerRoutineTools } from "./tools/routines.js";
import { registerScriptTools } from "./tools/scripts.js";
import { registerSeedUpdateTools } from "./tools/seed-updates.js";
import { registerSessionTools } from "./tools/session.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTopicTools } from "./topics.js";
import { toolError, toolText, withErrorHandling } from "./utils/errors.js";
import { SERVER_INSTRUCTIONS, VERSION } from "./version.js";

/**
 * Streamable HTTP MCP endpoint (`/mcp`), multi-tenant: every MCP session is
 * bound at initialize time to the authenticated user's own coaching DB, and
 * later requests must present a token for that same user. The tool layer
 * itself stays user-agnostic — it only ever sees a DB handle.
 *
 * Sessions are reaped on idle and bounded by hard caps: a session is expensive
 * (an McpServer with every tool registered, plus one live client connection per
 * attached gateway), and real connector clients routinely walk away without
 * sending the spec's `DELETE` — so `transport.onclose` is an optimization, never
 * the thing that keeps memory flat.
 */

/** A session with no request for this long is closed by the sweeper. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** How often the sweeper looks for idle sessions (only runs while any exist). */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;
/**
 * The ONLY hard ceiling is server-wide — there is deliberately no per-user cap.
 *
 * A fixed per-user limit is the wrong shape for this: it punishes a single user
 * on an otherwise idle server (one connector client was observed opening EIGHT
 * sessions for one user within five minutes of a restart, and a heavy user may
 * legitimately want far more) while doing nothing to make contention fair. So
 * one user may use the entire budget when nobody else needs it, and
 * `pickFairShareVictim` decides who gives a session back when the budget is
 * actually exhausted.
 *
 * Sized from measurement: a session with one mounted gateway costs ~3 MB of
 * heap, so 64 × ~3 MB ≈ 210 MB, comfortably inside the 512 MB heap this is
 * deployed with. This is the knob to raise if concurrent demand grows — keep
 * `sessions × 3 MB` well under the heap, and remember the idle sweeper is what
 * actually keeps memory flat. The cap is a backstop against pathological churn.
 */
export const MAX_SESSIONS_TOTAL = 64;

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  mounted: MountedGateway[];
  /** Epoch ms of the last request on this session — the eviction clock. */
  lastSeen: number;
};

/** The only fields fair-share selection needs — keeps the policy unit-testable. */
type SessionShare = { userId: string; lastSeen: number };

/**
 * Choose which session to drop when the server-wide cap is exceeded: the least
 * recently used session belonging to whoever currently holds the MOST.
 *
 * This converges on max-min fairness without any per-user configuration. A user
 * holding many sessions always loses their oldest first, so a user holding one
 * is never evicted while someone else holds two — light users cannot be starved
 * by a heavy one, and a client looping on initialize only evicts itself. When
 * every user holds the same number, it degrades to plain global LRU, which is
 * the only sensible tie-break left.
 *
 * The session just created is never the victim: it is by definition the most
 * recently used, so it can only be picked if its owner is the heaviest AND it is
 * their oldest — impossible.
 */
export function pickFairShareVictim(
  sessions: Iterable<readonly [string, SessionShare]>,
): string | undefined {
  const entries = [...sessions];
  const heldBy = new Map<string, number>();
  for (const [, s] of entries) heldBy.set(s.userId, (heldBy.get(s.userId) ?? 0) + 1);
  let most = 0;
  for (const held of heldBy.values()) if (held > most) most = held;

  let victim: string | undefined;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [sid, s] of entries) {
    if (heldBy.get(s.userId) !== most) continue;
    if (s.lastSeen < oldest) {
      oldest = s.lastSeen;
      victim = sid;
    }
  }
  return victim;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>();
  /** Per-user write budget, shared across all of a user's sessions. */
  private readonly writeLimiter = new RateLimiter(WRITES_PER_MINUTE, 60_000);
  /** Per-user daily notify_user budget — a check-in channel, not a firehose. */
  private readonly notifyLimiter = new RateLimiter(TELEGRAM_NOTIFY_PER_DAY, 24 * 60 * 60 * 1000);
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ctx: ServeContext) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The generic 1 MB body cap deliberately skips /mcp; this is its bound.
    if (Number(req.headers["content-length"] ?? 0) > MCP_BODY_MAX_BYTES) {
      sendJson(res, 413, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Request body too large" },
        id: null,
      });
      return;
    }
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
      session.lastSeen = Date.now();
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
      const prefix = toolPrefix(m.gateway);
      instructions += `\n\n## Connected server "${m.gateway.name}" (attached by the user)\n\nIts tools are mounted with the "${prefix}_" prefix — where its documentation names a tool, prepend "${prefix}_".`;
      if (m.instructions) instructions += `\n\n${m.instructions}`;
    }

    // Storage limits, resolved once per session (quota changes apply to new
    // sessions). Carries no identity — the tool layer stays user-agnostic.
    const user = getUser(this.ctx.authDb, auth.userId);
    const limits: WriteLimits = {
      quotaBytes: quotaBytesForUser(user, this.ctx.cfg.quotaDefaultMb),
      allowWrite: () => this.writeLimiter.allowKey(auth.userId),
    };

    const server = new McpServer({ name: "coaching-mcp", version: VERSION }, { instructions });
    registerSessionTools(server, db, limits, this.ctx.cfg.seedDir);
    registerReadTools(server, db, limits, this.ctx.cfg.seedDir);
    registerWriteTools(server, db, limits);
    registerEditTools(server, db, limits);
    registerHistoryTools(server, db);
    registerOpsTools(server, db, limits, this.ctx.cfg.seedDir);
    registerDeleteTools(server, db);
    registerOpenItemsTools(server, db, limits);
    registerMetricsTools(server, db, limits);
    registerRoutineTools(server, db, limits);
    registerScriptTools(server, db, limits);
    registerTopicTools(server, this.ctx.cfg.seedDir);
    registerSeedUpdateTools(server, db, this.ctx.cfg.seedDir, limits, this.ctx.log);
    this.registerQuotaRequestTool(server, db, auth.userId);
    // Structural opt-in like the integrations: the tool exists only when the
    // user linked their Telegram chat (and the operator configured a bot).
    if (this.ctx.notify.telegram && user?.telegram_chat_id) {
      this.registerNotifyUserTool(server, auth.userId);
    }

    // Opt-in integrations: tools appear only for users who connected the
    // service on their account page — each user acts with their own key.
    const secretsKey = this.ctx.cfg.secretsKey;
    if (secretsKey) {
      const hevyKey = getUserSecret(this.ctx.authDb, secretsKey, auth.userId, "hevy_api_key");
      if (hevyKey) registerHevyTools(server, new HevyClient(hevyKey));
      const icuRaw = getUserSecret(
        this.ctx.authDb,
        secretsKey,
        auth.userId,
        "intervals_credentials",
      );
      const icuCreds = icuRaw ? parseIntervalsCredentials(icuRaw) : undefined;
      if (icuCreds) registerIntervalsTools(server, new IntervalsClient(icuCreds));
    }

    if (mounted.length > 0) {
      const { mountedTools, rebuild } = attachGatewayTools(server, mounted, this.ctx.log);
      this.ctx.log(
        `mounted ${mountedTools} gateway tool(s) from ${mounted.length} server(s) for ${auth.userId}`,
      );
      this.registerRefreshGatewaysTool(server, auth.userId, mounted, rebuild);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, {
          transport,
          server,
          userId: auth.userId,
          mounted,
          lastSeen: Date.now(),
        });
        this.ctx.log(`mcp session ${sid} opened for ${auth.userId} (${this.sessions.size} open)`);
        this.startSweeper();
        void this.enforceCap();
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && this.sessions.delete(sid)) {
        this.ctx.log(`mcp session ${sid} closed (${this.sessions.size} open)`);
      }
      void closeMountedGateways(mounted);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  /**
   * Serve-mode-only tool: ask the operator for more storage. Registered here
   * (not in src/tools/) because it needs the user's identity and the notifier
   * — the same pattern as the per-user integrations.
   */
  private registerQuotaRequestTool(server: McpServer, db: Database.Database, userId: string): void {
    server.registerTool(
      "request_quota_increase",
      {
        title: "Request quota increase",
        description:
          "Ask the server operator to raise this account's storage quota. Use when a write fails " +
          "with a storage-quota error or usage warnings appear and content cannot reasonably be " +
          "consolidated or deleted. One open request at a time; the operator decides manually.",
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          reason: z
            .string()
            .min(10)
            .max(500)
            .describe("Short reason for the operator — what needs the space and roughly how much"),
        },
      },
      ({ reason }) =>
        withErrorHandling("request_quota_increase", () => {
          const user = getUser(this.ctx.authDb, userId);
          if (!user) return toolError("account no longer exists");
          const usage = contentBytes(db);
          const quotaMb = user.quota_mb ?? this.ctx.cfg.quotaDefaultMb;
          if (!createQuotaRequest(this.ctx.authDb, userId, reason, usage, quotaMb)) {
            return toolText(
              "A quota request from this account is already waiting for the operator — no new request was sent. The current one covers you.",
            );
          }
          this.ctx.notify.quotaRequest(user, reason, usage, quotaMb);
          this.ctx.log(`quota increase requested by ${user.email} (${userId})`);
          return toolText(
            `Request sent to the operator (currently using ${formatMb(usage)} MB of ${quotaMb} MB). ` +
              "The operator decides manually — usually within a day. Tell the user their request is on its way.",
          );
        }),
    );
  }

  /**
   * Re-read the tool lists of the user's connected servers, bypassing the cache.
   *
   * Registered only when the session actually mounted gateways. It exists
   * because the cache trades freshness for a ~4 s saving on every session
   * start: the escape hatch has to be reachable from inside a conversation,
   * since that is where the user notices a tool is missing.
   */
  private registerRefreshGatewaysTool(
    server: McpServer,
    userId: string,
    mounted: MountedGateway[],
    rebuild: (next: MountedGateway[]) => number,
  ): void {
    server.registerTool(
      "refresh_connected_servers",
      {
        title: "Refresh connected servers' tools",
        description:
          "Re-read the tool lists of the user's connected (gateway) servers, bypassing the cache. " +
          "Tool lists are cached for hours because they rarely change, so use this when the user " +
          "says they just added, updated or reconfigured a connected server and its tools are " +
          "missing, stale or wrong. Not needed otherwise, and not a fix for a failing tool call.",
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {},
      },
      async () => {
        const previous = mounted.map((m) => m.gateway.name);
        let refreshed: MountedGateway[];
        try {
          refreshed = await mountUserGateways(this.ctx, userId, { force: true });
        } catch (err) {
          return toolError(
            `refresh_connected_servers: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Replace the session's list in place: transport.onclose closes whatever
        // this array holds, so assigning a new array would leak the new
        // connections and double-close the old ones.
        const stale = [...mounted];
        mounted.length = 0;
        mounted.push(...refreshed);
        const toolCount = rebuild(refreshed);
        await closeMountedGateways(stale);
        // The client caches tools/list; without this the refresh is invisible.
        server.sendToolListChanged();
        this.ctx.log(
          `gateway tools refreshed for ${userId}: ${toolCount} tool(s) from ${refreshed.length} server(s)`,
        );
        const names = refreshed.map((m) => m.gateway.name);
        const missing = previous.filter((n) => !names.includes(n));
        return toolText(
          `Refreshed: ${toolCount} tool(s) from ${refreshed.length} connected server(s)` +
            (names.length > 0 ? ` (${names.join(", ")})` : "") +
            (missing.length > 0
              ? `. Could not reach: ${missing.join(", ")} — the user can check the connection on their account page.`
              : ".") +
            " The updated tools are available now.",
        );
      },
    );
  }

  /**
   * Send the user a Telegram message — registered only for users who linked
   * their chat. The headline use: a scheduled routine run delivers its
   * check-in or summary straight to the phone.
   */
  private registerNotifyUserTool(server: McpServer, userId: string): void {
    server.registerTool(
      "notify_user",
      {
        title: "Notify user via Telegram",
        description:
          "Send the user a Telegram message from their coaching server's bot. Use it to deliver " +
          "a scheduled routine's final check-in or summary to their phone, or a short " +
          "safety-relevant flag. Plain text only; keep it self-contained (it arrives as a push " +
          "notification, hours away from any conversation). Not a chat channel — the user " +
          "cannot reply to the coaching session through it.",
        annotations: { destructiveHint: false, openWorldHint: true },
        inputSchema: {
          message: z
            .string()
            .min(1)
            .max(4096)
            .describe("The message, in the user's preferred language; first line ≤70 chars"),
        },
      },
      async ({ message }) => {
        const bot = this.ctx.notify.telegram;
        const user = getUser(this.ctx.authDb, userId);
        if (!bot || !user?.telegram_chat_id) {
          return toolError("the user has no linked Telegram chat");
        }
        if (!this.notifyLimiter.allowKey(userId)) {
          return toolError(
            `daily Telegram message budget reached (${TELEGRAM_NOTIFY_PER_DAY}/day) — the message was NOT sent`,
          );
        }
        try {
          await bot.sendMessage(user.telegram_chat_id, message);
        } catch (err) {
          return toolError(
            `Telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.ctx.log(`notify_user delivered for ${userId}`);
        return toolText("Message delivered to the user's Telegram.");
      },
    );
  }

  // -------------------------------------------------------------------------
  // Session lifecycle. Every teardown path funnels through `dispose` so a
  // session can never be dropped from the map while its gateway clients stay
  // connected (that combination is invisible — it leaks with no session to
  // account for it).

  /** Close one session's transport, server and gateway clients. */
  private async dispose(sid: string, session: McpSession): Promise<void> {
    // Delete first: transport.close() fires onclose, which must find nothing.
    this.sessions.delete(sid);
    await session.transport.close().catch(() => {});
    await session.server.close().catch(() => {});
    await closeMountedGateways(session.mounted);
  }

  private async evict(sid: string, reason: string): Promise<void> {
    const session = this.sessions.get(sid);
    if (!session) return;
    await this.dispose(sid, session);
    this.ctx.log(`mcp session ${sid} evicted (${reason}); ${this.sessions.size} open`);
  }

  /**
   * Bring the server back under the global cap, taking each session from
   * whoever currently holds the most (see `pickFairShareVictim`). No-op until
   * the budget is genuinely exhausted, so a single user is free to use all of
   * it while nobody else needs it.
   */
  private async enforceCap(): Promise<void> {
    while (this.sessions.size > MAX_SESSIONS_TOTAL) {
      const victim = pickFairShareVictim(this.sessions);
      if (victim === undefined) return; // unreachable while size > 0; never spin
      await this.evict(victim, "server session cap (fair share)");
    }
  }

  /** The sweeper only runs while sessions exist — an idle server has no timer. */
  private startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepIdle(), SESSION_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private stopSweeper(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** Close every session idle past `SESSION_IDLE_TIMEOUT_MS`. */
  async sweepIdle(now = Date.now()): Promise<void> {
    for (const [sid, session] of this.sessions) {
      if (now - session.lastSeen >= SESSION_IDLE_TIMEOUT_MS) await this.evict(sid, "idle");
    }
    if (this.sessions.size === 0) this.stopSweeper();
  }

  /** Non-identifying counts for the health endpoint and the stats heartbeat. */
  stats(): { sessions: number; users: number; gateways: number } {
    const users = new Set<string>();
    let gateways = 0;
    for (const session of this.sessions.values()) {
      users.add(session.userId);
      gateways += session.mounted.length;
    }
    return { sessions: this.sessions.size, users: users.size, gateways };
  }

  /** Tear down all sessions for one user (account deletion). */
  async closeUserSessions(userId: string): Promise<void> {
    for (const [sid, session] of this.sessions) {
      if (session.userId !== userId) continue;
      await this.dispose(sid, session);
    }
    if (this.sessions.size === 0) this.stopSweeper();
  }

  async closeAll(): Promise<void> {
    this.stopSweeper();
    for (const [sid, session] of this.sessions) {
      await this.dispose(sid, session);
    }
  }
}
