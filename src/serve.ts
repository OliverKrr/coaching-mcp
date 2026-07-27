#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getHeapStatistics } from "node:v8";
import { handleAccountRoute, webAuth } from "./account.js";
import { handleAdminRoute } from "./admin.js";
import { handleAppRoute, parseProtectedApps } from "./apps-proxy.js";
import { adminEmails, allowedEmails, registrationOpen } from "./auth/allowlist.js";
import { openAuthDatabase } from "./auth/db.js";
import { createOidcProvider } from "./auth/oidc.js";
import { parseSecretsKey } from "./auth/secrets.js";
import { NotifyService } from "./notify.js";
import { authRateLimiter } from "./ratelimit.js";
import { TelegramBot } from "./telegram.js";
import { handleTelegramWebhook } from "./telegram-webhook.js";
import {
  handleAuthorize,
  handleOidcCallback,
  handleRegister,
  handleToken,
  oauthMetadata,
  protectedResourceMetadata,
} from "./auth/oauth.js";
import type { ServeConfig, ServeContext } from "./context.js";
import { sendJson } from "./http-util.js";
import { langCookieHeader } from "./web/i18n.js";
import { renderLanding, renderRoutines } from "./landing.js";
import { McpSessionManager } from "./mcp-http.js";
import { TenantManager } from "./tenancy.js";
import { VERSION } from "./version.js";

/**
 * `coaching-mcp serve` — the multi-user HTTP mode: Streamable HTTP MCP
 * endpoint plus built-in OAuth 2.1 authorization server (OIDC-federated
 * login + email allowlist) plus the self-service account page.
 */

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} [coaching-mcp serve] ${msg}\n`);
}

/** How often the runtime heartbeat lands in the log. */
const STATS_INTERVAL_MS = 15 * 60 * 1000;
/** Heap share above which the heartbeat shouts instead of noting. */
const HEAP_WARN_PCT = 85;
/** Requests slower than this get a log line naming the route. */
const SLOW_REQUEST_MS = 3000;

/**
 * Heap-pressure detector behind `/health`.
 *
 * The failure it exists to catch: the heap creeps to its ceiling, and V8 then
 * spends every core in back-to-back mark-compact runs. The process stays up,
 * still answers, still passes a TCP or "did it respond" probe — just seconds
 * late, which downstream clients see as an unreachable server. Probe LATENCY is
 * a bad detector for it (a healthy process on a loaded small host is slow too),
 * so the process reports its own condition instead.
 *
 * What makes it a spiral rather than a spike is the post-GC FLOOR: V8 routinely
 * fills the heap to 90% right before a major GC, and that is normal. A floor
 * that stays high means collection is no longer recovering anything. So we keep
 * the recent samples and judge the minimum — and only once the window is full,
 * so a just-booted process is never called unhealthy.
 *
 * Samples come from `/health` calls themselves (rate-limited below), so there is
 * no timer: a container healthcheck polling once a minute IS the sampler, and
 * with nobody polling there is no verdict to give.
 */
const HEAP_CRITICAL_PCT = 90;
const HEAP_WINDOW_SAMPLES = 5;
const HEAP_SAMPLE_MIN_GAP_MS = 20_000;

const heapFloorSamples: number[] = [];
let lastHeapSampleAt = 0;

export function sampleHeapPct(pct: number, now = Date.now()): void {
  if (now - lastHeapSampleAt < HEAP_SAMPLE_MIN_GAP_MS) return;
  lastHeapSampleAt = now;
  heapFloorSamples.push(pct);
  if (heapFloorSamples.length > HEAP_WINDOW_SAMPLES) heapFloorSamples.shift();
}

/** The post-GC floor over the sample window, or undefined until it is full. */
export function heapFloorPct(): number | undefined {
  if (heapFloorSamples.length < HEAP_WINDOW_SAMPLES) return undefined;
  return Math.min(...heapFloorSamples);
}

/** Test seam — the window is module state, and suites must not inherit it. */
export function resetHeapWatch(): void {
  heapFloorSamples.length = 0;
  lastHeapSampleAt = 0;
}

/**
 * Operational counters — deliberately non-identifying, because `/health` is
 * public. This is the view that makes a wedged process diagnosable after the
 * fact: session and gateway counts that should return to zero when nobody is
 * connected, against a heap share that should not climb across days.
 */
export function runtimeStats(mcpSessions: McpSessionManager): {
  sessions: number;
  gateways: number;
  heap_used_mb: number;
  heap_limit_mb: number;
  heap_pct: number;
  rss_mb: number;
  uptime_s: number;
} {
  const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
  const { sessions, gateways } = mcpSessions.stats();
  const heapLimit = getHeapStatistics().heap_size_limit;
  const mem = process.memoryUsage();
  return {
    sessions,
    gateways,
    heap_used_mb: mb(mem.heapUsed),
    heap_limit_mb: mb(heapLimit),
    heap_pct: Math.round((mem.heapUsed / heapLimit) * 100),
    rss_mb: mb(mem.rss),
    uptime_s: Math.round(process.uptime()),
  };
}

export function loadServeConfig(env: NodeJS.ProcessEnv = process.env): ServeConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required environment variable: ${name}`);
    return value;
  };
  return {
    dataDir: env.DATA_DIR ?? "/data",
    seedDir: env.SEED_DIR ?? "/seed",
    port: Number(env.PORT ?? 8000),
    publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
    accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL ?? 3600),
    refreshTokenTtlSec: Number(env.REFRESH_TOKEN_TTL ?? 7776000),
    secretsKey: parseSecretsKey(env.SECRETS_KEY),
    apps: parseProtectedApps(env),
    quotaDefaultMb: Number(env.QUOTA_DEFAULT_MB ?? 50),
  };
}

export function createContext(
  cfg: ServeConfig,
  env: NodeJS.ProcessEnv = process.env,
): { ctx: ServeContext; mcpSessions: McpSessionManager } {
  const oidcIssuer = env.OIDC_ISSUER ?? "https://accounts.google.com";
  const oidcClientId = env.OIDC_CLIENT_ID;
  const oidcClientSecret = env.OIDC_CLIENT_SECRET;
  if (!oidcClientId || !oidcClientSecret) {
    throw new Error("missing required environment variables: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET");
  }
  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID
      ? new TelegramBot({
          token: env.TELEGRAM_BOT_TOKEN,
          adminChatId: env.TELEGRAM_ADMIN_CHAT_ID,
          apiBase: env.TELEGRAM_API_BASE,
          log,
        })
      : undefined;
  const ctx: ServeContext = {
    cfg,
    authDb: openAuthDatabase(cfg.dataDir),
    oidc: createOidcProvider({
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
    }),
    tenants: new TenantManager(cfg.dataDir, cfg.seedDir),
    notify: new NotifyService(log, telegram, env.NOTIFY_URL),
    log,
  };
  return { ctx, mcpSessions: new McpSessionManager(ctx) };
}

export function buildHttpServer(ctx: ServeContext, mcpSessions: McpSessionManager): Server {
  return createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - started;
      // SSE streams are long-lived by design — timing them says nothing.
      if (ms < SLOW_REQUEST_MS || res.getHeader("content-type") === "text/event-stream") return;
      const path = (req.url ?? "/").split("?")[0];
      ctx.log(
        `slow request: ${req.method} ${path} → ${res.statusCode} in ${(ms / 1000).toFixed(1)}s`,
      );
    });
    route(ctx, mcpSessions, req, res).catch((err) => {
      log(`request error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
}

async function route(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // MCP is served at /mcp AND at the root: connector clients speak MCP to the
  // bare server URL (behind a prefix-stripping proxy that is "/"), and their
  // unauthenticated initialize must get the 401 + WWW-Authenticate challenge
  // that bootstraps the OAuth flow. Only a plain browser GET (no MCP session,
  // no Bearer token) falls through to the human landing page below.
  if (path === "/mcp" || path === "/") {
    const browserGet =
      path === "/" &&
      method === "GET" &&
      req.headers["mcp-session-id"] === undefined &&
      req.headers.authorization === undefined;
    if (!browserGet) {
      await mcpSessions.handle(req, res);
      return;
    }
  }

  // Auth endpoints get a per-IP rate limit (defense in depth behind the proxy/CDN).
  if (["/authorize", "/token", "/register", "/oidc/callback"].includes(path)) {
    if (!authRateLimiter.allow(req)) {
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
  }

  // Internal tools behind the login: /apps/<name>/**
  if (path.startsWith("/apps/")) {
    if (handleAppRoute(ctx, req, res, url, webAuth(ctx, req))) return;
  }

  // RFC 8414: with a path-suffixed issuer, discovery arrives as
  // /.well-known/oauth-authorization-server/<suffix> — accept any suffix.
  if (method === "GET" && path.startsWith("/.well-known/oauth-authorization-server")) {
    sendJson(res, 200, oauthMetadata(ctx));
    return;
  }
  if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    sendJson(res, 200, protectedResourceMetadata(ctx));
    return;
  }
  if (path === "/register" && method === "POST") {
    await handleRegister(ctx, req, res);
    return;
  }
  if (path === "/authorize" && method === "GET") {
    await handleAuthorize(ctx, url, res);
    return;
  }
  if (path === "/oidc/callback" && method === "GET") {
    await handleOidcCallback(ctx, url, res);
    return;
  }
  if (path === "/token" && method === "POST") {
    await handleToken(ctx, req, res);
    return;
  }
  if (path === "/telegram/webhook" && method === "POST") {
    await handleTelegramWebhook(ctx, req, res);
    return;
  }

  // A ?lang= click on the header toggle persists the choice for every page.
  const langCookie = langCookieHeader(url);
  if (langCookie) res.setHeader("set-cookie", langCookie);

  if (await handleAccountRoute(ctx, mcpSessions, req, res, url)) return;
  if (await handleAdminRoute(ctx, mcpSessions, req, res, url)) return;

  if (path === "/health" && method === "GET") {
    const stats = runtimeStats(mcpSessions);
    sampleHeapPct(stats.heap_pct);
    // 503 is the whole point of the endpoint: it is what lets an orchestrator
    // recycle a process that is technically alive but no longer serving.
    const floor = heapFloorPct();
    const wedged = floor !== undefined && floor >= HEAP_CRITICAL_PCT;
    if (wedged) ctx.log(`WARNING: unhealthy — heap floor ${floor}% of limit over recent samples`);
    sendJson(res, wedged ? 503 : 200, {
      ok: !wedged,
      ...(wedged ? { reason: "heap_pressure", heap_floor_pct: floor } : {}),
      version: VERSION,
      ...stats,
    });
    return;
  }
  if (path === "/" && method === "GET") {
    renderLanding(ctx, req, res, url);
    return;
  }
  if (path === "/routines" && method === "GET") {
    renderRoutines(ctx, req, res, url);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

export async function main(): Promise<void> {
  log(`booting v${VERSION} (node ${process.version}, pid ${process.pid})`);
  const cfg = loadServeConfig();
  const { ctx, mcpSessions } = createContext(cfg);

  const admins = adminEmails();
  const bootstrap = allowedEmails();
  log(
    `membership: ${admins.size} admin(s), ${bootstrap.size} bootstrap-allowlisted, ` +
      `registration ${registrationOpen() ? "open" : "closed"}`,
  );
  if (admins.size === 0 && bootstrap.size === 0) {
    log(
      "WARNING: ADMIN_EMAILS and ALLOWED_EMAILS are both empty — nobody can log in, and nobody can approve requests on /admin",
    );
  }
  const bot = ctx.notify.telegram;
  if (bot) {
    bot.setup(cfg.publicUrl).catch((err: unknown) => {
      log(
        `WARNING: telegram setup failed (notifications disabled until restart): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  const server = buildHttpServer(ctx, mcpSessions);
  server.listen(cfg.port, () => {
    log(`ready — listening on :${cfg.port}, public URL ${cfg.publicUrl}`);
  });

  // Runtime heartbeat. Cheap, and the only record of how the process behaved
  // between two incidents: a session or gateway count that never falls back to
  // zero, or a heap share that only climbs, names the culprit without a repro.
  const heartbeat = setInterval(() => {
    const s = runtimeStats(mcpSessions);
    const { users } = mcpSessions.stats();
    const line =
      `stats: ${s.sessions} session(s) for ${users} user(s), ${s.gateways} gateway tool-source(s), ` +
      `heap ${s.heap_used_mb}/${s.heap_limit_mb} MB (${s.heap_pct}%), rss ${s.rss_mb} MB, up ${Math.round(s.uptime_s / 60)} min`;
    log(s.heap_pct >= HEAP_WARN_PCT ? `WARNING: heap pressure — ${line}` : line);
  }, STATS_INTERVAL_MS);
  heartbeat.unref();

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`);
    clearInterval(heartbeat);
    server.close(() => {
      mcpSessions
        .closeAll()
        .catch(() => {})
        .finally(() => {
          ctx.tenants.closeAll();
          ctx.authDb.close();
          process.exit(0);
        });
    });
    // Open SSE streams keep the server from closing; force after grace period.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
