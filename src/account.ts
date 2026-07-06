import { zipSync, strToU8 } from "fflate";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { handleDataGet, handleDataPost } from "./account-data.js";
import { appsForEmail } from "./apps-proxy.js";
import { startAccountLogin } from "./auth/oauth.js";
import { deleteUser, deleteWebSession, getUser, getWebSession } from "./auth/db.js";
import {
  deleteAllUserSecrets,
  deleteUserSecret,
  getUserSecretMeta,
  setUserSecret,
} from "./auth/secrets.js";
import {
  createGateway,
  deleteGateway,
  deleteUserGateways,
  finishGatewayConnect,
  getGateway,
  listGateways,
  startGatewayConnect,
  type Gateway,
} from "./gateways.js";
import { HevyClient } from "./integrations/hevy.js";
import type { ServeContext } from "./context.js";
import {
  clearedCookie,
  htmlEscape,
  page,
  parseCookies,
  parseParams,
  readBody,
  redirect,
  sendHtml,
} from "./http-util.js";
import type { McpSessionManager } from "./mcp-http.js";
import { snapshotDocuments } from "./snapshot.js";

/**
 * Self-service account page: profile + data summary, full data export, and
 * account deletion. This is the server's data-rights surface — a user can see,
 * take away, or erase everything the server stores about them without the
 * operator's involvement.
 */

const SESSION_COOKIE = "account_session";

export type WebAuth = { sessionId: string; userId: string; csrf: string };

export function webAuth(ctx: ServeContext, req: IncomingMessage): WebAuth | undefined {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return undefined;
  const session = getWebSession(ctx.authDb, sessionId);
  return session ? { sessionId, userId: session.userId, csrf: session.csrf } : undefined;
}

/**
 * Routes under /account. Returns false when the path is not ours. Session and
 * CSRF checks happen once here for every account route, including the data
 * browser/editor (account-data.ts).
 */
export async function handleAccountRoute(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const base = ctx.cfg.publicUrl;
  const path = url.pathname;
  if (path !== "/account" && !path.startsWith("/account/")) return false;

  if (path === "/account/login" && req.method === "GET") {
    await startAccountLogin(ctx, res);
    return true;
  }

  const auth = webAuth(ctx, req);
  if (!auth) {
    if (path === "/account" && req.method === "GET") {
      sendHtml(
        res,
        200,
        page(
          "Coaching account",
          `<h1>Coaching account</h1>
<p>Sign in to view, export, or delete the data this coaching server stores about you.</p>
<p><a href="${base}/account/login"><button>Sign in</button></a></p>`,
        ),
      );
    } else {
      redirect(res, `${base}/account`);
    }
    return true;
  }

  if (req.method === "GET") {
    if (path === "/account") {
      renderAccountPage(ctx, res, auth);
      return true;
    }
    if (path === "/account/gateways/callback") {
      await handleGatewayCallback(ctx, res, auth, url);
      return true;
    }
    return handleDataGet(ctx, res, auth, url);
  }

  if (req.method === "POST") {
    const form = parseParams(await readBody(req), req.headers["content-type"]);
    if (form.get("csrf") !== auth.csrf) {
      sendHtml(
        res,
        403,
        page(
          "Invalid request",
          "<h1>Invalid request</h1><p>Stale form — go back to the account page and try again.</p>",
        ),
      );
      return true;
    }
    if (path === "/account/logout") {
      deleteWebSession(ctx.authDb, auth.sessionId);
      res.writeHead(302, {
        location: `${base}/account`,
        "set-cookie": clearedCookie(SESSION_COOKIE),
      });
      res.end();
      return true;
    }
    if (path === "/account/export") {
      exportData(ctx, res, auth.userId);
      return true;
    }
    if (path === "/account/delete") {
      await deleteAccount(ctx, mcpSessions, res, auth, form.get("confirm_email") ?? "");
      return true;
    }
    if (path === "/account/integrations/hevy") {
      await saveHevyKey(ctx, res, auth, form.get("api_key") ?? "");
      return true;
    }
    if (path === "/account/integrations/hevy/delete") {
      deleteUserSecret(ctx.authDb, auth.userId, "hevy_api_key");
      redirect(res, `${base}/account`);
      return true;
    }
    if (path === "/account/gateways") {
      await addGateway(ctx, res, auth, form);
      return true;
    }
    const gatewayAction = /^\/account\/gateways\/(gw_[A-Za-z0-9_-]+)\/(connect|delete)$/.exec(path);
    if (gatewayAction) {
      await handleGatewayAction(
        ctx,
        res,
        auth,
        gatewayAction[1] as string,
        gatewayAction[2] as "connect" | "delete",
      );
      return true;
    }
    return handleDataPost(ctx, res, auth, url, form);
  }

  return false;
}

async function saveHevyKey(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  apiKey: string,
): Promise<void> {
  const base = ctx.cfg.publicUrl;
  const key = apiKey.trim();
  if (!ctx.cfg.secretsKey || !key) {
    sendHtml(res, 400, page("Invalid request", "<h1>Invalid request</h1>"));
    return;
  }
  let valid: boolean;
  try {
    valid = await new HevyClient(key).validateKey();
  } catch (err) {
    ctx.log(`hevy key validation failed: ${err instanceof Error ? err.message : String(err)}`);
    sendHtml(
      res,
      502,
      page(
        "Hevy unreachable",
        `<h1>Hevy is unreachable</h1><p>Could not verify the key right now — nothing was saved. Try again in a minute.</p><p><a href="${base}/account">Back to account</a></p>`,
      ),
    );
    return;
  }
  if (!valid) {
    sendHtml(
      res,
      400,
      page(
        "Key rejected",
        `<h1>Hevy rejected this key</h1><p>Check it under hevy.com → Settings → Developer (requires Hevy Pro). Nothing was saved.</p><p><a href="${base}/account">Back to account</a></p>`,
      ),
    );
    return;
  }
  setUserSecret(ctx.authDb, ctx.cfg.secretsKey, auth.userId, "hevy_api_key", key);
  ctx.log(`hevy key configured for ${auth.userId}`);
  redirect(res, `${base}/account`);
}

function accountError(ctx: ServeContext, res: ServerResponse, title: string, msg: string): void {
  sendHtml(
    res,
    400,
    page(
      title,
      `<h1>${htmlEscape(title)}</h1><p>${htmlEscape(msg)}</p><p><a href="${ctx.cfg.publicUrl}/account">Back to account</a></p>`,
    ),
  );
}

async function addGateway(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): Promise<void> {
  if (!ctx.cfg.secretsKey) {
    accountError(ctx, res, "Unavailable", "Connected servers are disabled on this deployment.");
    return;
  }
  let gateway: Gateway;
  try {
    gateway = createGateway(ctx, auth.userId, {
      name: form.get("name") ?? "",
      url: form.get("url") ?? "",
      prefix: form.get("prefix") ?? "",
      bearer: form.get("bearer") ?? "",
    });
  } catch (err) {
    accountError(
      ctx,
      res,
      "Could not add server",
      err instanceof Error ? err.message : "invalid input",
    );
    return;
  }
  await connectAndRedirect(ctx, res, gateway);
}

async function handleGatewayAction(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  id: string,
  action: "connect" | "delete",
): Promise<void> {
  const base = ctx.cfg.publicUrl;
  const gateway = getGateway(ctx.authDb, auth.userId, id);
  if (!gateway) {
    accountError(ctx, res, "Not found", "This connected server no longer exists.");
    return;
  }
  if (action === "delete") {
    deleteGateway(ctx, auth.userId, id);
    ctx.log(`gateway removed: ${id} for ${auth.userId}`);
    redirect(res, `${base}/account`);
    return;
  }
  await connectAndRedirect(ctx, res, gateway);
}

/** Try to connect; OAuth upstreams 302 the browser to their authorize page. */
async function connectAndRedirect(
  ctx: ServeContext,
  res: ServerResponse,
  gateway: Gateway,
): Promise<void> {
  const base = ctx.cfg.publicUrl;
  try {
    const outcome = await startGatewayConnect(ctx, gateway);
    if (outcome.kind === "redirect") {
      redirect(res, outcome.url);
      return;
    }
    ctx.log(`gateway connected: ${gateway.id} (${outcome.toolCount} tools) for ${gateway.user_id}`);
  } catch (err) {
    ctx.log(
      `gateway connect failed: ${gateway.id} — ${err instanceof Error ? err.message : String(err)}`,
    );
    // Status + error are recorded on the row; the account page shows them.
  }
  redirect(res, `${base}/account`);
}

async function handleGatewayCallback(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
): Promise<void> {
  const base = ctx.cfg.publicUrl;
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    accountError(
      ctx,
      res,
      "Authorization declined",
      `The server declined the authorization: ${upstreamError}. Nothing was connected.`,
    );
    return;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    accountError(ctx, res, "Invalid callback", "Missing code or state parameter.");
    return;
  }
  try {
    const { gateway, toolCount } = await finishGatewayConnect(ctx, auth.userId, state, code);
    ctx.log(`gateway authorized: ${gateway.id} (${toolCount} tools) for ${auth.userId}`);
    redirect(res, `${base}/account`);
  } catch (err) {
    accountError(
      ctx,
      res,
      "Authorization failed",
      err instanceof Error ? err.message : "token exchange failed",
    );
  }
}

function gatewayStatusLabel(g: Gateway): string {
  switch (g.status) {
    case "connected":
      return `<strong>connected</strong> <span class="muted">(${htmlEscape(g.last_connected_at ?? "")} UTC)</span>`;
    case "needs_auth":
      return `sign-in required`;
    case "error":
      return `error <span class="muted">${htmlEscape(g.last_error ?? "")}</span>`;
    default:
      return `<span class="muted">not connected yet</span>`;
  }
}

function renderAccountPage(ctx: ServeContext, res: ServerResponse, auth: WebAuth): void {
  const base = ctx.cfg.publicUrl;
  const user = getUser(ctx.authDb, auth.userId);
  if (!user) {
    deleteWebSession(ctx.authDb, auth.sessionId);
    res.writeHead(302, {
      location: `${base}/account`,
      "set-cookie": clearedCookie(SESSION_COOKIE),
    });
    res.end();
    return;
  }
  const db = ctx.tenants.open(user.id);
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const dbPath = join(ctx.tenants.userDir(user.id), "skill.db");
  const dbSizeKb = existsSync(dbPath) ? Math.round(statSync(dbPath).size / 1024) : 0;
  const csrf = htmlEscape(auth.csrf);

  let integrationsCard = "";
  if (ctx.cfg.secretsKey) {
    const hevyMeta = getUserSecretMeta(ctx.authDb, user.id, "hevy_api_key");
    const hevyBlock = hevyMeta
      ? `<p>Hevy: <strong>connected</strong> <span class="muted">(key updated ${htmlEscape(hevyMeta.updated_at)} UTC)</span></p>
<form method="post" action="${base}/account/integrations/hevy">
<input type="hidden" name="csrf" value="${csrf}">
<label for="hevy_key">Replace API key:</label>
<input type="password" id="hevy_key" name="api_key" autocomplete="off" required>
<p><button>Update key</button></p>
</form>
<form method="post" action="${base}/account/integrations/hevy/delete">
<input type="hidden" name="csrf" value="${csrf}">
<button class="danger">Disconnect Hevy</button>
</form>`
      : `<p>Hevy: <span class="muted">not connected</span></p>
<p class="muted">Connect your own Hevy account (requires Hevy Pro) and your coach gains tools to read workouts and manage routines. Key: hevy.com → Settings → Developer.</p>
<form method="post" action="${base}/account/integrations/hevy">
<input type="hidden" name="csrf" value="${csrf}">
<label for="hevy_key">Hevy API key:</label>
<input type="password" id="hevy_key" name="api_key" autocomplete="off" required>
<p><button>Connect Hevy</button></p>
</form>`;
    integrationsCard = `<div class="card">
<h2>Integrations</h2>
${hevyBlock}
<p class="muted">Keys are stored encrypted, are never shown again, and are removed with your account. New Claude conversations pick changes up immediately.</p>
</div>`;
  }

  let gatewaysCard = "";
  if (ctx.cfg.secretsKey) {
    const gateways = listGateways(ctx.authDb, user.id);
    const rows = gateways
      .map(
        (g) => `<tr>
<td><strong>${htmlEscape(g.name)}</strong>${g.prefix ? ` <span class="muted">(tools prefixed ${htmlEscape(g.prefix)}_)</span>` : ""}<br><span class="muted">${htmlEscape(g.url)}</span></td>
<td>${gatewayStatusLabel(g)}</td>
<td>
<form method="post" action="${base}/account/gateways/${g.id}/connect"><input type="hidden" name="csrf" value="${csrf}"><button>${g.status === "connected" ? "Re-check" : "Connect"}</button></form>
<form method="post" action="${base}/account/gateways/${g.id}/delete"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">Remove</button></form>
</td>
</tr>`,
      )
      .join("\n");
    gatewaysCard = `<div class="card">
<h2>Connected MCP servers</h2>
<p class="muted">Attach other MCP servers here and their tools appear in your coaching conversations — so one Claude connector is enough even on plans that allow only one. You sign in to each server as yourself (your own account and subscription there); credentials are stored encrypted and removed with your account.</p>
${rows ? `<table>\n${rows}\n</table>` : ""}
<form method="post" action="${base}/account/gateways">
<input type="hidden" name="csrf" value="${csrf}">
<p><label for="gw_name">Name:</label> <input id="gw_name" name="name" required maxlength="40" placeholder="e.g. IcuSync"></p>
<p><label for="gw_url">Server URL:</label> <input id="gw_url" name="url" type="url" required placeholder="https://…"></p>
<p><label for="gw_bearer">Access token</label> <span class="muted">(only for servers using a static token)</span>: <input id="gw_bearer" name="bearer" type="password" autocomplete="off"></p>
<p><label for="gw_prefix">Tool prefix</label> <span class="muted">(optional, a–z 0–9 _; use when tool names clash)</span>: <input id="gw_prefix" name="prefix" maxlength="16" pattern="[a-z0-9_]*"></p>
<p><button>Add &amp; connect</button></p>
</form>
<p class="muted">Servers with their own sign-in open an authorization page — like adding a connector in Claude. New Claude conversations pick up the tools immediately.</p>
</div>`;
  }

  const apps = appsForEmail(ctx, user.email);
  const appsCard = apps.length
    ? `<div class="card">
<h2>Tools</h2>
${apps.map((a) => `<p><a href="${base}/apps/${a.name}/">${htmlEscape(a.name)}</a></p>`).join("\n")}
</div>`
    : "";

  sendHtml(
    res,
    200,
    page(
      "Coaching account",
      `<h1>Coaching account</h1>
<div class="card">
<table>
<tr><th>Signed in as</th><td>${htmlEscape(user.email)}</td></tr>
<tr><th>Member since</th><td>${htmlEscape(user.created_at)} UTC</td></tr>
<tr><th>Last login</th><td>${htmlEscape(user.last_login_at ?? "—")} UTC</td></tr>
</table>
<form method="post" action="${base}/account/logout"><input type="hidden" name="csrf" value="${csrf}"><button>Sign out</button></form>
</div>

<div class="card">
<h2>Your data</h2>
<table>
<tr><th>Knowledge sections</th><td>${count("SELECT COUNT(*) AS n FROM sections")}</td></tr>
<tr><th>Reference documents</th><td>${count("SELECT COUNT(*) AS n FROM refs")}</td></tr>
<tr><th>Journal entries</th><td>${count("SELECT COUNT(*) AS n FROM journal")}</td></tr>
<tr><th>Open items</th><td>${count("SELECT COUNT(*) AS n FROM open_items WHERE status = 'open'")}</td></tr>
<tr><th>Routines</th><td>${count("SELECT COUNT(*) AS n FROM routines")}</td></tr>
<tr><th>Database size</th><td>${dbSizeKb} KB</td></tr>
</table>
<p><a href="${base}/account/data"><button>View &amp; edit your data</button></a></p>
<form method="post" action="${base}/account/export">
<input type="hidden" name="csrf" value="${csrf}">
<button>Download everything (zip)</button>
</form>
<p class="muted">The zip contains every document as markdown plus a restorable copy of your database — the complete record this server holds about you.</p>
</div>

${integrationsCard}
${gatewaysCard}
${appsCard}

<div class="card">
<h2>Delete account</h2>
<p>Immediately and irreversibly deletes your coaching database and revokes all connected clients. Operator backups expire on the deployment's own retention schedule.</p>
<form method="post" action="${base}/account/delete">
<input type="hidden" name="csrf" value="${csrf}">
<label for="confirm_email">Type your email address to confirm:</label>
<input type="email" id="confirm_email" name="confirm_email" autocomplete="off" required>
<p><button class="danger">Delete my account and all data</button></p>
</form>
</div>`,
    ),
  );
}

function exportData(ctx: ServeContext, res: ServerResponse, userId: string): void {
  const db = ctx.tenants.open(userId);
  const files: Record<string, Uint8Array> = {};
  for (const doc of snapshotDocuments(db)) {
    files[doc.path] = strToU8(doc.content);
  }
  files["skill.db"] = db.serialize();
  const zip = zipSync(files);
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="coaching-export-${date}.zip"`,
    "content-length": zip.byteLength,
  });
  res.end(Buffer.from(zip));
}

async function deleteAccount(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  res: ServerResponse,
  auth: WebAuth,
  confirmEmail: string,
): Promise<void> {
  const user = getUser(ctx.authDb, auth.userId);
  if (!user || confirmEmail.trim().toLowerCase() !== user.email) {
    sendHtml(
      res,
      400,
      page(
        "Confirmation failed",
        `<h1>Confirmation failed</h1><p>The email address did not match. Nothing was deleted.</p><p><a href="${ctx.cfg.publicUrl}/account">Back to account</a></p>`,
      ),
    );
    return;
  }
  await mcpSessions.closeUserSessions(user.id);
  ctx.tenants.deleteUserData(user.id);
  deleteUserGateways(ctx.authDb, user.id);
  deleteAllUserSecrets(ctx.authDb, user.id);
  deleteUser(ctx.authDb, user.id); // also removes tokens + web sessions
  ctx.log(`account deleted: ${user.email} (${user.id})`);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "set-cookie": clearedCookie(SESSION_COOKIE),
  });
  res.end(
    page(
      "Account deleted",
      `<h1>Account deleted</h1><p>Your coaching data has been removed and all connected clients signed out. Signing in again would start a fresh, empty account.</p>`,
    ),
  );
}
