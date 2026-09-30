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
 *
 * The rewrites are idempotent. An app that reads the X-Forwarded-Prefix we send
 * and emits its own prefixed URLs is the better-behaved case, not a broken one:
 * prefixing those again would produce /prefix/prefix/… and break every link, so
 * anything already under the prefix is left alone.
 *
 * An app built to live under a fixed path (a framework base path) gets it as the
 * path of its target URL: `name=http://host:port/base` forwards `/apps/name/x`
 * as `/base/x`. `PROTECTED_APP_<NAME>_HEADER="Name: value"` adds one request
 * header to everything forwarded, so the app can tell the proxy apart from any
 * other local client; a client-sent header of that name is replaced, never
 * passed through.
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

/**
 * Whether a root-absolute URL already sits under `prefix`. The boundary check
 * matters: "/appstore" must not count as being under "/apps".
 */
export function isUnderPrefix(prefix: string, url: string): boolean {
  if (!url.startsWith(prefix)) return false;
  const next = url.charAt(prefix.length);
  return next === "" || next === "/" || next === '"' || next === "?" || next === "#";
}

/** Move a root-absolute URL onto `prefix`, unless it is already there. */
export function withPrefix(prefix: string, url: string): string {
  return isUnderPrefix(prefix, url) ? url : prefix + url;
}

const ROOT_ABSOLUTE_ATTR =
  /(\s(?:href|src|action|hx-get|hx-post|hx-put|hx-patch|hx-delete)=")\/(?!\/)/g;

/** Move root-absolute URL attributes in an HTML body onto `prefix`. */
export function rewriteHtmlPrefix(html: string, prefix: string): string {
  return html.replace(ROOT_ABSOLUTE_ATTR, (match, attr: string, offset: number) =>
    isUnderPrefix(prefix, html.slice(offset + match.length - 1)) ? match : `${attr}${prefix}/`,
  );
}

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
        `PROTECTED_APPS entry not understood: "${trimmed}" (want name=http://host:port[/base])`,
      );
    }
    const target = new URL(url);
    if (target.search || target.hash) {
      throw new Error(`PROTECTED_APPS entry "${name}": the target URL takes no query or fragment`);
    }
    const basePath = target.pathname === "/" ? "" : target.pathname;
    const envName = name.toUpperCase().replaceAll("-", "_");
    const header = parseAppHeader(name, env[`PROTECTED_APP_${envName}_HEADER`]);
    const emailsVar = `PROTECTED_APP_${envName}_EMAILS`;
    const emails = new Set(
      (env[emailsVar] ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    apps.push({ name, url, basePath, emails, ...(header ? { header } : {}) });
  }
  return apps;
}

function parseAppHeader(
  name: string,
  spec: string | undefined,
): { name: string; value: string } | undefined {
  if (!spec?.trim()) return undefined;
  const colon = spec.indexOf(":");
  const headerName = spec.slice(0, colon).trim().toLowerCase();
  const value = spec.slice(colon + 1).trim();
  if (colon === -1 || !/^[a-z0-9-]+$/.test(headerName) || !value) {
    throw new Error(`PROTECTED_APP header for "${name}" not understood (want "Name: value")`);
  }
  if (headerName === "host" || headerName === "x-forwarded-prefix" || HOP_BY_HOP.has(headerName)) {
    throw new Error(`PROTECTED_APP header for "${name}" may not set ${headerName}`);
  }
  return { name: headerName, value };
}

/** Path and headers of the upstream request for one proxied request. */
export function upstreamRequest(
  app: ProtectedApp,
  prefixPath: string,
  targetPath: string,
  reqHeaders: IncomingMessage["headers"],
): { path: string; headers: Record<string, string | string[]> } {
  const target = new URL(app.url);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === "host" || k === "content-length") continue;
    if (app.header && k === app.header.name) continue;
    headers[k] = v;
  }
  headers.host = target.host;
  headers["x-forwarded-prefix"] = prefixPath;
  headers["accept-encoding"] = "identity"; // we rewrite HTML — no compressed bodies
  if (app.header) headers[app.header.name] = app.header.value;
  return { path: app.basePath + targetPath, headers };
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
  const { path, headers } = upstreamRequest(app, prefixPath, targetPath, req.headers);

  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path,
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
      if (location?.startsWith("/")) outHeaders.location = withPrefix(prefixPath, location);
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
          const body = rewriteHtmlPrefix(Buffer.concat(chunks).toString("utf8"), prefixPath);
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
