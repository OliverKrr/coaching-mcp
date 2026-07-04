import { zipSync, strToU8 } from "fflate";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { startAccountLogin } from "./auth/oauth.js";
import { deleteUser, deleteWebSession, getUser, getWebSession } from "./auth/db.js";
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

type WebAuth = { sessionId: string; userId: string; csrf: string };

function webAuth(ctx: ServeContext, req: IncomingMessage): WebAuth | undefined {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return undefined;
  const session = getWebSession(ctx.authDb, sessionId);
  return session ? { sessionId, userId: session.userId, csrf: session.csrf } : undefined;
}

/** Routes under /account. Returns false when the path is not ours. */
export async function handleAccountRoute(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const base = ctx.cfg.publicUrl;
  const path = url.pathname;

  if (path === "/account" && req.method === "GET") {
    const auth = webAuth(ctx, req);
    if (!auth) {
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
      return true;
    }
    renderAccountPage(ctx, res, auth);
    return true;
  }

  if (path === "/account/login" && req.method === "GET") {
    await startAccountLogin(ctx, res);
    return true;
  }

  if (
    req.method === "POST" &&
    ["/account/export", "/account/delete", "/account/logout"].includes(path)
  ) {
    const auth = webAuth(ctx, req);
    if (!auth) {
      redirect(res, `${base}/account`);
      return true;
    }
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
    await deleteAccount(ctx, mcpSessions, res, auth, form.get("confirm_email") ?? "");
    return true;
  }

  return false;
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
<tr><th>Database size</th><td>${dbSizeKb} KB</td></tr>
</table>
<form method="post" action="${base}/account/export">
<input type="hidden" name="csrf" value="${csrf}">
<button>Download everything (zip)</button>
</form>
<p class="muted">The zip contains every document as markdown plus a restorable copy of your database — the complete record this server holds about you.</p>
</div>

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
