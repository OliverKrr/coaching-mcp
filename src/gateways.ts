import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomToken } from "./auth/db.js";
import { deleteUserSecret, getUserSecret, setUserSecret } from "./auth/secrets.js";
import type { ServeContext } from "./context.js";
import { VERSION } from "./version.js";

/**
 * Per-user MCP gateway: users attach upstream MCP servers (e.g. a fitness
 * analysis connector) on their account page, and their coaching sessions mount
 * those servers' tools alongside the native ones. This exists because
 * free-plan Claude accounts allow only ONE custom connector.
 *
 * Principles:
 * - Verbatim passthrough — upstream tool names, descriptions, input schemas,
 *   annotations, and server instructions reach Claude untouched (that curated
 *   context is the upstream's value; we must not re-model it).
 * - Every user authenticates to the upstream as themselves (own subscription,
 *   own OAuth grant); credentials live in the sealed per-user secret store.
 * - A dead or unauthorized upstream degrades to "tools absent + status on the
 *   account page" — it never breaks the coaching session.
 */

export type Gateway = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  prefix: string;
  auth_kind: "none" | "bearer" | "oauth";
  status: "new" | "connected" | "needs_auth" | "error";
  last_error: string | null;
  created_at: string;
  last_connected_at: string | null;
};

export const MAX_GATEWAYS_PER_USER = 5;
export const MAX_GATEWAY_TOOLS = 200;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;
const PENDING_TTL_SEC = 600;

// ---------------------------------------------------------------------------
// SSRF guard — users enter URLs this server will fetch.

/** Test-only escape hatch: allows http:// and private addresses (127.0.0.1 mock upstreams). */
function insecureAllowed(): boolean {
  return process.env.GATEWAY_ALLOW_INSECURE === "1";
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateAddress(ip: string): boolean {
  if (!ip.includes(":")) return isPrivateV4(ip);
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1] as string);
  return false;
}

/**
 * https-only + no private/internal targets. DNS-rebinding after this check is
 * neutralized by TLS itself: a hostile name pointing at an internal IP cannot
 * complete a handshake because internal services hold no valid cert for it.
 */
export async function assertSafeGatewayUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (insecureAllowed()) return;
  if (url.protocol !== "https:") throw new Error("gateway URLs must use https");
  if (url.username || url.password) throw new Error("credentials in the URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (addresses.length === 0) throw new Error("gateway host does not resolve");
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error("gateway host resolves to a private or internal address");
    }
  }
}

/** Transport fetch: re-validates every hop so redirects cannot escape the policy. */
async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  let url = new URL(String(input));
  for (let hop = 0; hop < 4; hop++) {
    await assertSafeGatewayUrl(url.href);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return res;
  }
  throw new Error("gateway: too many redirects");
}

// ---------------------------------------------------------------------------
// Storage (rows in auth.db; credentials in the sealed per-user secret store)

export function listGateways(db: Database.Database, userId: string): Gateway[] {
  return db
    .prepare("SELECT * FROM gateways WHERE user_id = ? ORDER BY created_at, id")
    .all(userId) as Gateway[];
}

export function getGateway(db: Database.Database, userId: string, id: string): Gateway | undefined {
  return db.prepare("SELECT * FROM gateways WHERE id = ? AND user_id = ?").get(id, userId) as
    | Gateway
    | undefined;
}

export function createGateway(
  ctx: ServeContext,
  userId: string,
  input: { name: string; url: string; prefix: string; bearer: string },
): Gateway {
  const name = input.name.trim();
  if (!name || name.length > 40) throw new Error("name must be 1–40 characters");
  const prefix = input.prefix.trim();
  if (!/^[a-z0-9_]{0,16}$/.test(prefix)) {
    throw new Error("prefix must match [a-z0-9_]{0,16}");
  }
  if (listGateways(ctx.authDb, userId).length >= MAX_GATEWAYS_PER_USER) {
    throw new Error(`at most ${MAX_GATEWAYS_PER_USER} connected servers per account`);
  }
  const bearer = input.bearer.trim();
  const id = `gw_${randomToken(6)}`;
  ctx.authDb
    .prepare(
      "INSERT INTO gateways (id, user_id, name, url, prefix, auth_kind) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, userId, name, input.url.trim(), prefix, bearer ? "bearer" : "none");
  if (bearer && ctx.cfg.secretsKey) {
    setUserSecret(ctx.authDb, ctx.cfg.secretsKey, userId, `gateway:${id}:bearer`, bearer);
  }
  return getGateway(ctx.authDb, userId, id) as Gateway;
}

export function deleteGateway(ctx: ServeContext, userId: string, id: string): void {
  ctx.authDb.prepare("DELETE FROM gateways WHERE id = ? AND user_id = ?").run(id, userId);
  ctx.authDb
    .prepare("DELETE FROM gateway_pending WHERE gateway_id = ? AND user_id = ?")
    .run(id, userId);
  for (const slot of ["bearer", "tokens", "client"]) {
    deleteUserSecret(ctx.authDb, userId, `gateway:${id}:${slot}`);
  }
}

/** Account deletion: drop every gateway row + pending state (sealed slots go via deleteAllUserSecrets). */
export function deleteUserGateways(db: Database.Database, userId: string): void {
  db.prepare("DELETE FROM gateways WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM gateway_pending WHERE user_id = ?").run(userId);
}

function markStatus(
  db: Database.Database,
  id: string,
  status: Gateway["status"],
  lastError: string | null,
): void {
  if (status === "connected") {
    db.prepare(
      "UPDATE gateways SET status = 'connected', last_error = NULL, last_connected_at = datetime('now') WHERE id = ?",
    ).run(id);
  } else {
    db.prepare("UPDATE gateways SET status = ?, last_error = ? WHERE id = ?").run(
      status,
      lastError,
      id,
    );
  }
}

// ---------------------------------------------------------------------------
// Upstream OAuth (SDK client auth): DCR + PKCE, credentials sealed per user

class GatewayAuthProvider implements OAuthClientProvider {
  /** Captured instead of actually redirecting — the HTTP layer 302s the browser. */
  authorizationUrl?: URL;

  constructor(
    private readonly authDb: Database.Database,
    private readonly secretsKey: Buffer,
    private readonly gw: Gateway,
    private readonly publicUrl: string,
    private readonly flowState?: string,
  ) {}

  private slot(name: string): string {
    return `gateway:${this.gw.id}:${name}`;
  }
  private readJson<T>(name: string): T | undefined {
    const raw = getUserSecret(this.authDb, this.secretsKey, this.gw.user_id, this.slot(name));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
  private writeJson(name: string, value: unknown): void {
    setUserSecret(
      this.authDb,
      this.secretsKey,
      this.gw.user_id,
      this.slot(name),
      JSON.stringify(value),
    );
  }

  get redirectUrl(): string {
    return `${this.publicUrl}/account/gateways/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "coaching-mcp gateway",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string {
    if (!this.flowState)
      throw new UnauthorizedError("authorization must start from the account page");
    return this.flowState;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.readJson("client");
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.writeJson("client", info);
  }
  tokens(): OAuthTokens | undefined {
    return this.readJson("tokens");
  }
  saveTokens(tokens: OAuthTokens): void {
    this.writeJson("tokens", tokens);
  }
  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }
  saveCodeVerifier(codeVerifier: string): void {
    if (!this.flowState)
      throw new UnauthorizedError("authorization must start from the account page");
    this.authDb
      .prepare(
        `INSERT INTO gateway_pending (state, gateway_id, user_id, code_verifier, expires_at)
			 VALUES (?, ?, ?, ?, unixepoch() + ${PENDING_TTL_SEC})
			 ON CONFLICT(state) DO UPDATE SET code_verifier = excluded.code_verifier, expires_at = excluded.expires_at`,
      )
      .run(this.flowState, this.gw.id, this.gw.user_id, codeVerifier);
  }
  codeVerifier(): string {
    const row = this.authDb
      .prepare("SELECT code_verifier FROM gateway_pending WHERE state = ?")
      .get(this.flowState ?? "") as { code_verifier: string | null } | undefined;
    if (!row?.code_verifier)
      throw new UnauthorizedError("authorization state expired — reconnect from the account page");
    return row.code_verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") {
      deleteUserSecret(this.authDb, this.gw.user_id, this.slot("tokens"));
    }
    if (scope === "all" || scope === "client") {
      deleteUserSecret(this.authDb, this.gw.user_id, this.slot("client"));
    }
  }
}

// ---------------------------------------------------------------------------
// Connecting

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway ${what} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function requireKey(ctx: ServeContext): Buffer {
  const key = ctx.cfg.secretsKey;
  if (!key) throw new Error("SECRETS_KEY is not configured — gateways are disabled");
  return key;
}

function makeTransport(
  ctx: ServeContext,
  gw: Gateway,
  flowState?: string,
): { transport: StreamableHTTPClientTransport; provider?: GatewayAuthProvider } {
  const key = requireKey(ctx);
  if (gw.auth_kind === "bearer") {
    const bearer = getUserSecret(ctx.authDb, key, gw.user_id, `gateway:${gw.id}:bearer`);
    return {
      transport: new StreamableHTTPClientTransport(new URL(gw.url), {
        fetch: guardedFetch,
        requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined,
      }),
    };
  }
  const provider = new GatewayAuthProvider(ctx.authDb, key, gw, ctx.cfg.publicUrl, flowState);
  return {
    transport: new StreamableHTTPClientTransport(new URL(gw.url), {
      fetch: guardedFetch,
      authProvider: provider,
    }),
    provider,
  };
}

async function connectClient(
  ctx: ServeContext,
  gw: Gateway,
  flowState?: string,
): Promise<{ client: Client; provider?: GatewayAuthProvider }> {
  await assertSafeGatewayUrl(gw.url);
  const { transport, provider } = makeTransport(ctx, gw, flowState);
  const client = new Client({ name: "coaching-mcp-gateway", version: VERSION });
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
  } catch (err) {
    await transport.close().catch(() => {});
    throw Object.assign(err as Error, { gatewayProvider: provider });
  }
  return { client, provider };
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const result = await withTimeout(
      client.listTools(cursor ? { cursor } : undefined),
      CONNECT_TIMEOUT_MS,
      "tools/list",
    );
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor && tools.length < MAX_GATEWAY_TOOLS);
  return tools.slice(0, MAX_GATEWAY_TOOLS);
}

export type ConnectOutcome =
  | { kind: "connected"; toolCount: number }
  | { kind: "redirect"; url: string };

/**
 * Account-page "Connect": try existing/no credentials; a 401 upstream starts
 * the OAuth dance (discovery + DCR + PKCE via the SDK) and yields the
 * authorize URL for the browser.
 */
export async function startGatewayConnect(ctx: ServeContext, gw: Gateway): Promise<ConnectOutcome> {
  const state = randomToken(24);
  try {
    const { client } = await connectClient(ctx, gw, state);
    try {
      const tools = await listAllTools(client);
      markStatus(ctx.authDb, gw.id, "connected", null);
      return { kind: "connected", toolCount: tools.length };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    const provider = (err as { gatewayProvider?: GatewayAuthProvider }).gatewayProvider;
    if (err instanceof UnauthorizedError && provider?.authorizationUrl) {
      if (gw.auth_kind === "none") {
        ctx.authDb.prepare("UPDATE gateways SET auth_kind = 'oauth' WHERE id = ?").run(gw.id);
      }
      markStatus(ctx.authDb, gw.id, "needs_auth", null);
      return { kind: "redirect", url: provider.authorizationUrl.href };
    }
    markStatus(ctx.authDb, gw.id, "error", trimError(err));
    throw err;
  }
}

/** OAuth callback: exchange the code (PKCE verifier from gateway_pending), then verify by mounting once. */
export async function finishGatewayConnect(
  ctx: ServeContext,
  userId: string,
  state: string,
  code: string,
): Promise<{ gateway: Gateway; toolCount: number }> {
  const pending = ctx.authDb
    .prepare(
      "SELECT gateway_id, user_id, expires_at FROM gateway_pending WHERE state = ? AND expires_at > unixepoch()",
    )
    .get(state) as { gateway_id: string; user_id: string } | undefined;
  if (!pending || pending.user_id !== userId) {
    throw new Error("unknown or expired authorization state — reconnect from the account page");
  }
  const gw = getGateway(ctx.authDb, userId, pending.gateway_id);
  if (!gw) throw new Error("connected server no longer exists");

  await assertSafeGatewayUrl(gw.url);
  const key = requireKey(ctx);
  const provider = new GatewayAuthProvider(ctx.authDb, key, gw, ctx.cfg.publicUrl, state);
  const transport = new StreamableHTTPClientTransport(new URL(gw.url), {
    fetch: guardedFetch,
    authProvider: provider,
  });
  try {
    await withTimeout(transport.finishAuth(code), CONNECT_TIMEOUT_MS, "token exchange");
  } finally {
    await transport.close().catch(() => {});
    ctx.authDb.prepare("DELETE FROM gateway_pending WHERE state = ?").run(state);
  }

  const { client } = await connectClient(ctx, gw);
  try {
    const tools = await listAllTools(client);
    markStatus(ctx.authDb, gw.id, "connected", null);
    return { gateway: gw, toolCount: tools.length };
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Session mounting

export type MountedGateway = {
  gateway: Gateway;
  client: Client;
  tools: Tool[];
  instructions?: string;
};

function trimError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * Open every configured upstream for one user's new MCP session. Failures are
 * recorded on the gateway row (surfaced on the account page) and skipped.
 */
export async function mountUserGateways(
  ctx: ServeContext,
  userId: string,
): Promise<MountedGateway[]> {
  if (!ctx.cfg.secretsKey) return [];
  const rows = listGateways(ctx.authDb, userId);
  if (rows.length === 0) return [];
  const mounted = await Promise.all(
    rows.map(async (gw): Promise<MountedGateway | undefined> => {
      try {
        const { client } = await connectClient(ctx, gw);
        const tools = await listAllTools(client);
        markStatus(ctx.authDb, gw.id, "connected", null);
        return { gateway: gw, client, tools, instructions: client.getInstructions() };
      } catch (err) {
        const needsAuth = err instanceof UnauthorizedError;
        markStatus(ctx.authDb, gw.id, needsAuth ? "needs_auth" : "error", trimError(err));
        ctx.log(`gateway ${gw.id} (${gw.name}) skipped for session: ${trimError(err)}`);
        return undefined;
      }
    }),
  );
  return mounted.filter((m): m is MountedGateway => m !== undefined);
}

export async function closeMountedGateways(mounted: MountedGateway[]): Promise<void> {
  for (const m of mounted) {
    await m.client.close().catch(() => {});
  }
}

type StoredHandler = (request: unknown, extra: unknown) => Promise<unknown>;
type ServerInternals = { _requestHandlers: Map<string, StoredHandler> };
type McpServerInternals = { _registeredTools: Record<string, unknown> };

/**
 * Pinned-SDK internals check (@modelcontextprotocol/sdk 1.29): verbatim
 * passthrough needs the underlying Server's stored tools/list + tools/call
 * handlers and the McpServer's registered-tool names. A unit test calls this
 * so an SDK upgrade that moves these fails loudly, not silently.
 */
export function sdkInternals(server: McpServer): {
  handlers: Map<string, StoredHandler>;
  nativeNames: Set<string>;
} {
  const handlers = (server.server as unknown as ServerInternals)._requestHandlers;
  const registered = (server as unknown as McpServerInternals)._registeredTools;
  if (!(handlers instanceof Map) || typeof registered !== "object" || registered === null) {
    throw new Error("MCP SDK internals changed — gateway passthrough needs updating");
  }
  return { handlers, nativeNames: new Set(Object.keys(registered)) };
}

/**
 * Merge upstream tools into the session at the protocol layer: tools/list
 * appends the upstream Tool objects VERBATIM (registerTool would re-serialize
 * schemas through zod and lose the upstream's exact shape), tools/call routes
 * by name and forwards untouched. Collisions with native or earlier-gateway
 * tools are skipped and reported.
 */
export function attachGatewayTools(
  server: McpServer,
  mounted: MountedGateway[],
  log: (msg: string) => void,
): { mountedTools: number; skipped: string[] } {
  const { handlers, nativeNames } = sdkInternals(server);
  const nativeList = handlers.get("tools/list");
  const nativeCall = handlers.get("tools/call");
  if (!nativeList || !nativeCall) {
    throw new Error("MCP SDK internals changed — native tools handlers not found");
  }

  const routes = new Map<string, { client: Client; upstreamName: string; gatewayName: string }>();
  const extraTools: Tool[] = [];
  const skipped: string[] = [];
  for (const m of mounted) {
    for (const tool of m.tools) {
      const exposed = m.gateway.prefix ? `${m.gateway.prefix}_${tool.name}` : tool.name;
      if (nativeNames.has(exposed) || routes.has(exposed)) {
        skipped.push(`${m.gateway.name}: ${exposed}`);
        continue;
      }
      if (extraTools.length >= MAX_GATEWAY_TOOLS) {
        skipped.push(`${m.gateway.name}: ${exposed} (tool cap reached)`);
        continue;
      }
      routes.set(exposed, {
        client: m.client,
        upstreamName: tool.name,
        gatewayName: m.gateway.name,
      });
      extraTools.push(exposed === tool.name ? tool : { ...tool, name: exposed });
    }
  }
  if (skipped.length > 0) log(`gateway tools skipped (name collision/cap): ${skipped.join(", ")}`);

  server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const base = (await nativeList(req, extra)) as { tools: Tool[] };
    return { ...base, tools: [...base.tools, ...extraTools] };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const route = routes.get(req.params.name);
    if (!route) return (await nativeCall(req, extra)) as CallToolResult;
    try {
      return (await route.client.callTool(
        { name: route.upstreamName, arguments: req.params.arguments ?? {} },
        undefined,
        { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
      )) as CallToolResult;
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Connected server '${route.gatewayName}' failed: ${trimError(err)}. The user can check it on their account page.`,
          },
        ],
        isError: true,
      };
    }
  });

  return { mountedTools: extraTools.length, skipped };
}
