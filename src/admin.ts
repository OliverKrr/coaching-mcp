import type { IncomingMessage, ServerResponse } from "node:http";
import { webAuth, type WebAuth } from "./account.js";
import { isAdminEmail, registrationOpen } from "./auth/allowlist.js";
import { deleteQuotaRequest, getUser, listQuotaRequests, listUsers, type User } from "./auth/db.js";
import type { ServeContext } from "./context.js";
import { htmlEscape, parseParams, readBody, redirect, sendHtml, sendJson } from "./http-util.js";
import {
  approveUser,
  disableUser,
  enableUser,
  grantQuota,
  MAX_PENDING_USERS,
  purgeUser,
  rejectUser,
} from "./membership.js";
import type { McpSessionManager } from "./mcp-http.js";
import { contentBytes, formatMb } from "./quota.js";
import { page } from "./web/layout.js";
import { badge, emailText } from "./web/ui.js";

/**
 * Operator surface at /admin: pending access requests, quota requests, and
 * the user list with usage and membership actions. Gated on ADMIN_EMAILS via
 * the normal web session; everyone else gets a plain 404 so the page's
 * existence is not advertised. Deliberately English-only — this is the
 * operator's own console, not a user-facing page.
 *
 * Telegram's inline buttons drive the same transitions (membership.ts); this
 * page is the always-available source of truth.
 */
export async function handleAdminRoute(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/admin" && !path.startsWith("/admin/")) return false;

  const auth = webAuth(ctx, req);
  const adminUser = auth ? getUser(ctx.authDb, auth.userId) : undefined;
  if (!auth || !adminUser || !isAdminEmail(adminUser.email)) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  if (req.method === "GET" && path === "/admin") {
    renderAdminPage(ctx, res, auth);
    return true;
  }

  if (req.method === "POST") {
    const form = parseParams(await readBody(req), req.headers["content-type"]);
    if (form.get("csrf") !== auth.csrf) {
      sendHtml(
        res,
        403,
        page(
          "Invalid request",
          "<h1>Invalid request</h1><p>Stale form — go back to the admin page and try again.</p>",
        ),
      );
      return true;
    }
    return handleAdminPost(ctx, mcpSessions, res, path, form);
  }

  sendJson(res, 404, { error: "not_found" });
  return true;
}

async function handleAdminPost(
  ctx: ServeContext,
  mcpSessions: McpSessionManager,
  res: ServerResponse,
  path: string,
  form: URLSearchParams,
): Promise<boolean> {
  const back = `${ctx.cfg.publicUrl}/admin`;
  const action =
    /^\/admin\/users\/(u_[0-9a-f]+)\/(approve|reject|disable|enable|delete|quota|quota-dismiss)$/.exec(
      path,
    );
  if (!action) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  const userId = action[1] as string;
  switch (action[2]) {
    case "approve":
      approveUser(ctx, userId);
      break;
    case "reject":
      rejectUser(ctx, userId);
      break;
    case "disable":
      disableUser(ctx, userId);
      break;
    case "enable":
      enableUser(ctx, userId);
      break;
    case "delete":
      await purgeUser(ctx, mcpSessions, userId);
      break;
    case "quota": {
      const raw = (form.get("quota_mb") ?? "").trim();
      const mb = raw === "" ? null : Number(raw);
      if (mb !== null && (!Number.isFinite(mb) || mb < 1 || mb > 100_000)) {
        sendHtml(
          res,
          400,
          page(
            "Invalid quota",
            `<h1>Invalid quota</h1><p>Quota must be 1–100000 MB, or empty for the default.</p><p><a href="${back}">Back to admin</a></p>`,
          ),
        );
        return true;
      }
      grantQuota(ctx, userId, mb);
      break;
    }
    case "quota-dismiss":
      deleteQuotaRequest(ctx.authDb, userId);
      break;
  }
  redirect(res, back);
  return true;
}

function userStatusBadge(user: User): string {
  switch (user.status) {
    case "active":
      return badge("ok", "active");
    case "pending":
      return badge("warn", "pending");
    case "disabled":
      return badge("err", "disabled");
    default:
      return badge("muted", "rejected");
  }
}

function renderAdminPage(ctx: ServeContext, res: ServerResponse, auth: WebAuth): void {
  const base = ctx.cfg.publicUrl;
  const csrf = htmlEscape(auth.csrf);
  const users = listUsers(ctx.authDb);
  const pending = users.filter((u) => u.status === "pending");
  const quotaRequests = listQuotaRequests(ctx.authDb);
  const byId = new Map(users.map((u) => [u.id, u]));

  const post = (userId: string, action: string, label: string, cls = ""): string =>
    `<form method="post" action="${base}/admin/users/${userId}/${action}"><input type="hidden" name="csrf" value="${csrf}"><button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;

  const pendingRows = pending
    .map(
      (u) => `<tr>
<td><strong>${emailText(u.email)}</strong>${u.name ? `<br><span class="muted">${htmlEscape(u.name)}</span>` : ""}</td>
<td>${htmlEscape(u.created_at)} UTC</td>
<td>${u.telegram_chat_id ? badge("ok", "Telegram linked") : badge("muted", "no Telegram")}</td>
<td>${post(u.id, "approve", "Approve")}${post(u.id, "reject", "Reject", "danger")}</td>
</tr>`,
    )
    .join("\n");
  const pendingCard = `<div class="card">
<h2>Access requests</h2>
${
  pendingRows
    ? `<div class="scroll"><table><tr><th>Who</th><th>Requested</th><th>Notify</th><th></th></tr>${pendingRows}</table></div>`
    : '<p class="muted">No pending requests.</p>'
}
<p class="muted">Registration is ${registrationOpen() ? "open" : "closed (REGISTRATION=closed)"} · backstop ${pending.length}/${MAX_PENDING_USERS} pending.</p>
</div>`;

  const quotaRows = quotaRequests
    .map((q) => {
      const u = byId.get(q.user_id);
      if (!u) return "";
      const current = u.quota_mb ?? ctx.cfg.quotaDefaultMb;
      const half = Math.ceil(current * 1.5);
      const double = current * 2;
      return `<tr>
<td><strong>${emailText(u.email)}</strong><br><span class="muted">${htmlEscape(q.created_at)} UTC · using ${formatMb(q.usage_bytes)} of ${current} MB</span></td>
<td>${htmlEscape(q.reason)}</td>
<td>
<form method="post" action="${base}/admin/users/${u.id}/quota"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="quota_mb" value="${half}"><button>Grant ${half} MB</button></form>
<form method="post" action="${base}/admin/users/${u.id}/quota"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="quota_mb" value="${double}"><button>Grant ${double} MB</button></form>
${post(u.id, "quota-dismiss", "Dismiss", "quiet")}
</td>
</tr>`;
    })
    .join("\n");
  const quotaCard = quotaRows
    ? `<div class="card">
<h2>Storage quota requests</h2>
<div class="scroll"><table><tr><th>Who</th><th>Reason</th><th></th></tr>${quotaRows}</table></div>
</div>`
    : "";

  const userRows = users
    .filter((u) => u.status !== "pending")
    .map((u) => {
      const usage = ctx.tenants.hasData(u.id)
        ? `${formatMb(contentBytes(ctx.tenants.open(u.id)))} MB`
        : "—";
      const quota =
        u.quota_mb !== null ? `${u.quota_mb} MB` : `default (${ctx.cfg.quotaDefaultMb} MB)`;
      const actions =
        u.status === "active"
          ? `${post(u.id, "disable", "Disable", "danger")}`
          : `${post(u.id, "enable", "Enable")}`;
      return `<tr>
<td><strong>${emailText(u.email)}</strong>${u.name ? `<br><span class="muted">${htmlEscape(u.name)}</span>` : ""}${isAdminEmail(u.email) ? `<br>${badge("ok", "admin")}` : ""}</td>
<td>${userStatusBadge(u)}<br><span class="muted">last login ${htmlEscape(u.last_login_at ?? "—")}</span></td>
<td>${usage} of ${quota}
<form method="post" action="${base}/admin/users/${u.id}/quota"><input type="hidden" name="csrf" value="${csrf}"><input name="quota_mb" inputmode="numeric" size="6" placeholder="MB"> <button class="quiet">Set</button></form></td>
<td>${actions}
<details><summary class="muted">Delete…</summary>${post(u.id, "delete", "Delete account + data", "danger")}</details></td>
</tr>`;
    })
    .join("\n");
  const usersCard = `<div class="card">
<h2>Users</h2>
${
  userRows
    ? `<div class="scroll"><table><tr><th>Who</th><th>Status</th><th>Storage</th><th></th></tr>${userRows}</table></div>`
    : '<p class="muted">No users yet.</p>'
}
<p class="muted">Storage counts stored content; the quota field left empty resets to the default. Disabling revokes every token immediately; deleting removes the coaching database — same as self-service deletion.</p>
</div>`;

  sendHtml(
    res,
    200,
    page(
      "Admin",
      `<h1>Admin</h1>
${pendingCard}
${quotaCard}
${usersCard}`,
      { wide: true, nav: { base, active: "admin", signedIn: true, admin: true, path: "/admin" } },
    ),
  );
}
