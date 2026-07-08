import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProtectedApp, ServeContext } from "./context.js";
import { getUser } from "./auth/db.js";
import { redirect, sendHtml } from "./http-util.js";
import { page } from "./web/layout.js";

/**
 * Authenticated reverse proxy for internal web tools: /apps/<name>/* requires
 * the account web session AND the user's email on the app's own allowlist
 * (login alone is deliberately not enough — a personal dashboard must not be
 * visible to every coached user). Bodies stream both ways; HTML responses get
 * root-absolute references rewritten onto the prefix so small dashboards that
 * emit href="/…" keep working. WebSockets are not supported.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export function parseProtectedApps(env: NodeJS.ProcessEnv): ProtectedApp[] {
  const spec = env.PROTECTED_APPS ?? "";
  const apps: ProtectedApp[] = [];
  for (const entry of spec.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    const url = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/\/+$/, "");
    if (eq === -1 || !/^[a-z0-9-]+$/.test(name) || !/^https?:\/\//.test(url)) {
      throw new Error(
        `PROTECTED_APPS entry not understood: "${trimmed}" (want name=http://host:port)`,
      );
    }
    const emailsVar = `PROTECTED_APP_${name.toUpperCase().replaceAll("-", "_")}_EMAILS`;
    const emails = new Set(
      (env[emailsVar] ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    apps.push({ name, url, emails });
  }
  return apps;
}

export function appsForEmail(ctx: ServeContext, email: string): ProtectedApp[] {
  return ctx.cfg.apps.filter((a) => a.emails.has(email.toLowerCase()));
}

/** Routes /apps/<name>/**. Returns false when the path is not ours. */
export function handleAppRoute(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: { userId: string } | undefined,
): boolean {
  const match = /^\/apps\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return false;
  const app = ctx.cfg.apps.find((a) => a.name === match[1]);
  if (!app) return false;

  if (!auth) {
    redirect(res, `${ctx.cfg.publicUrl}/account`);
    return true;
  }
  const user = getUser(ctx.authDb, auth.userId);
  if (!user || !app.emails.has(user.email)) {
    sendHtml(
      res,
      403,
      page(
        "Not authorized",
        "<h1>Not authorized</h1><p>Your account has no access to this tool.</p>",
      ),
    );
    return true;
  }

  const prefix = `${ctx.cfg.publicUrl}/apps/${app.name}`;
  const prefixPath = new URL(prefix).pathname; // path part only, for cookies/Location
  const targetPath = (match[2] ?? "/") + url.search;
  proxy(ctx, app, prefixPath, targetPath, req, res);
  return true;
}

function proxy(
  ctx: ServeContext,
  app: ProtectedApp,
  prefixPath: string,
  targetPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const target = new URL(app.url);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === "host" || k === "content-length") continue;
    headers[k] = v;
  }
  headers.host = target.host;
  headers["x-forwarded-prefix"] = prefixPath;
  headers["accept-encoding"] = "identity"; // we rewrite HTML — no compressed bodies

  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: targetPath,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k)) continue;
        outHeaders[k] = v;
      }
      // Location + cookie paths move onto the prefix
      const location = upstreamRes.headers.location;
      if (location?.startsWith("/")) outHeaders.location = prefixPath + location;
      const setCookie = upstreamRes.headers["set-cookie"];
      if (setCookie) {
        outHeaders["set-cookie"] = setCookie.map((c) =>
          c.replace(/;(\s*)Path=\//i, `;$1Path=${prefixPath}/`),
        );
      }

      const contentType = upstreamRes.headers["content-type"] ?? "";
      if (contentType.includes("text/html")) {
        // Buffer & rewrite root-absolute references onto the prefix.
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (c: Buffer) => chunks.push(c));
        upstreamRes.on("end", () => {
          const body = Buffer.concat(chunks)
            .toString("utf8")
            .replace(
              /(\s(?:href|src|action|hx-get|hx-post|hx-put|hx-patch|hx-delete)=")\/(?!\/)/g,
              `$1${prefixPath}/`,
            );
          delete outHeaders["content-length"];
          res.writeHead(upstreamRes.statusCode ?? 502, {
            ...outHeaders,
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
        });
        upstreamRes.on("error", () => res.end());
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstream.setTimeout(60_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    ctx.log(`app proxy ${app.name} error: ${err.message}`);
    if (!res.headersSent) {
      sendHtml(
        res,
        502,
        page(
          "Tool unavailable",
          "<h1>Tool unavailable</h1><p>The app behind this page is not reachable right now.</p>",
        ),
      );
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}
