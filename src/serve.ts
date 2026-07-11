#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
    sendJson(res, 200, { ok: true, version: VERSION });
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

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`);
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
