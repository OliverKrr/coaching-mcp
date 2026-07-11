import { zipSync, strToU8 } from "fflate";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { handleDataGet, handleDataPost } from "./account-data.js";
import { appsForEmail } from "./apps-proxy.js";
import { isAdminEmail } from "./auth/allowlist.js";
import { startAccountLogin } from "./auth/oauth.js";
import {
  createTelegramLinkToken,
  deleteWebSession,
  getUser,
  getWebSession,
  setUserTelegramChat,
  type User,
} from "./auth/db.js";
import { deleteUserSecret, getUserSecretMeta, setUserSecret } from "./auth/secrets.js";
import { purgeUser } from "./membership.js";
import { contentBytes, formatMb, quotaBytesForUser } from "./quota.js";
import {
  createGateway,
  deleteGateway,
  finishGatewayConnect,
  getGateway,
  hasSealedQuery,
  listGateways,
  startGatewayConnect,
  SUGGESTED_GATEWAYS,
  toolPrefix,
  type Gateway,
} from "./gateways.js";
import { HevyClient } from "./integrations/hevy.js";
import type { ServeContext } from "./context.js";
import {
  clearedCookie,
  htmlEscape,
  parseCookies,
  parseParams,
  readBody,
  redirect,
  sendHtml,
} from "./http-util.js";
import { pickLang, type Lang } from "./web/i18n.js";
import { page } from "./web/layout.js";
import { badge, emailText } from "./web/ui.js";
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
  const lang = pickLang(req, url);
  const t = lang === "de" ? ACCOUNT_DE : ACCOUNT_EN;

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
          t.title,
          `<h1>${t.title}</h1>
<p>${t.gateIntro}</p>
<p><a href="${base}/account/login"><button>${t.gateButton}</button></a></p>`,
          { nav: { base, active: "account", lang, path: "/account" } },
        ),
      );
    } else {
      redirect(res, `${base}/account`);
    }
    return true;
  }

  if (req.method === "GET") {
    if (path === "/account") {
      renderAccountPage(ctx, res, auth, url.searchParams.get("preset"), lang);
      return true;
    }
    if (path === "/account/gateways/callback") {
      await handleGatewayCallback(ctx, res, auth, url);
      return true;
    }
    return handleDataGet(ctx, res, auth, url, lang);
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
      await deleteAccount(ctx, mcpSessions, res, auth, form.get("confirm_email") ?? "", t);
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
    if (path === "/account/telegram/unlink") {
      setUserTelegramChat(ctx.authDb, auth.userId, null);
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

/**
 * Telegram opt-in on the account page: post-approval linking (approval itself
 * offers the same link on the pending page). Hidden when no bot is configured
 * or the bot's username is not resolved yet (setup pending/failed).
 */
function telegramBlock(ctx: ServeContext, user: User, csrf: string, t: AccountStrings): string {
  const bot = ctx.notify.telegram;
  if (!bot) return "";
  if (user.telegram_chat_id) {
    return `<p>Telegram: ${badge("ok", t.connected)}</p>
<form method="post" action="${ctx.cfg.publicUrl}/account/telegram/unlink">
<input type="hidden" name="csrf" value="${csrf}">
<button class="quiet">${t.telegramUnlink}</button>
</form>`;
  }
  const link = bot.deepLink(createTelegramLinkToken(ctx.authDb, user.id));
  if (!link) return "";
  return `<p>Telegram: ${badge("muted", t.notConnected)}</p>
<p class="muted">${t.telegramIntro}</p>
<p><a href="${htmlEscape(link)}">${t.telegramConnect}</a></p>`;
}

function gatewayStatusLabel(g: Gateway, t: AccountStrings): string {
  switch (g.status) {
    case "connected":
      return `${badge("ok", t.gwStatusConnected)} <span class="muted">(${htmlEscape(g.last_connected_at ?? "")} UTC)</span>`;
    case "needs_auth":
      return badge("warn", t.gwStatusNeedsAuth);
    case "error":
      return `${badge("err", t.gwStatusError)} <span class="muted">${htmlEscape(g.last_error ?? "")}</span>`;
    default:
      return badge("muted", t.gwStatusNew);
  }
}

function renderAccountPage(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  presetId: string | null,
  lang: Lang,
): void {
  const t = lang === "de" ? ACCOUNT_DE : ACCOUNT_EN;
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
  const usedBytes = contentBytes(db);
  const quotaBytes = quotaBytesForUser(user, ctx.cfg.quotaDefaultMb);
  const csrf = htmlEscape(auth.csrf);

  let integrationsCard = "";
  if (ctx.cfg.secretsKey) {
    const hevyMeta = getUserSecretMeta(ctx.authDb, user.id, "hevy_api_key");
    const hevyBlock = hevyMeta
      ? `<p>Hevy: ${badge("ok", t.connected)} <span class="muted">(${t.keyUpdated} ${htmlEscape(hevyMeta.updated_at)} UTC)</span></p>
<form method="post" action="${base}/account/integrations/hevy">
<input type="hidden" name="csrf" value="${csrf}">
<label for="hevy_key">${t.replaceKey}</label>
<input type="password" id="hevy_key" name="api_key" autocomplete="off" required>
<p><button>${t.updateKey}</button></p>
</form>
<form method="post" action="${base}/account/integrations/hevy/delete">
<input type="hidden" name="csrf" value="${csrf}">
<button class="danger">${t.disconnectHevy}</button>
</form>`
      : `<p>Hevy: ${badge("muted", t.notConnected)}</p>
<p class="muted">${t.hevyIntro}</p>
<form method="post" action="${base}/account/integrations/hevy">
<input type="hidden" name="csrf" value="${csrf}">
<label for="hevy_key">${t.hevyKeyLabel}</label>
<input type="password" id="hevy_key" name="api_key" autocomplete="off" required>
<p><button>${t.connectHevy}</button></p>
</form>`;
    integrationsCard = `<div class="card">
<h2>${t.integrations}</h2>
${hevyBlock}
<p class="muted">${t.keysNote}</p>
</div>`;
  }

  let gatewaysCard = "";
  if (ctx.cfg.secretsKey) {
    const gateways = listGateways(ctx.authDb, user.id);
    const attachedPrefixes = new Set(gateways.map((g) => toolPrefix(g)));
    const suggestions = SUGGESTED_GATEWAYS.filter((s) => !attachedPrefixes.has(s.prefix));
    const preset = suggestions.find((s) => s.id === presetId);
    const suggestionsBlock = suggestions.length
      ? `<p class="muted">${t.gwSuggested}</p>
${suggestions
  .map(
    (s) => `<p><strong>${htmlEscape(s.name)}</strong> — ${htmlEscape(s.description[lang])}.<br>
<span class="muted">${t.gwGetUrlAt} <a href="${htmlEscape(s.website)}" target="_blank" rel="noopener noreferrer">${htmlEscape(s.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>${t.gwThen}</span> <a href="${base}/account?preset=${encodeURIComponent(s.id)}#add-server">${t.gwPrefill}</a>.</p>`,
  )
  .join("\n")}`
      : "";
    const presetUrlHint = preset
      ? `<br><span class="muted"><strong>${htmlEscape(preset.name)}:</strong> ${htmlEscape(preset.urlHint[lang])}</span>`
      : "";
    const rows = gateways
      .map(
        (g) => `<tr>
<td><strong>${htmlEscape(g.name)}</strong> <span class="muted">(${t.gwTools} ${htmlEscape(toolPrefix(g))}_*)</span><br><span class="muted">${htmlEscape(g.url)}${hasSealedQuery(ctx.authDb, g) ? ` · ${t.gwSealedQuery}` : ""}</span></td>
<td>${gatewayStatusLabel(g, t)}</td>
<td>
<form method="post" action="${base}/account/gateways/${g.id}/connect"><input type="hidden" name="csrf" value="${csrf}"><button${g.status === "connected" ? ' class="quiet"' : ""}>${g.status === "connected" ? t.gwRecheck : t.gwConnect}</button></form>
<form method="post" action="${base}/account/gateways/${g.id}/delete"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">${t.gwRemove}</button></form>
</td>
</tr>`,
      )
      .join("\n");
    gatewaysCard = `<div class="card">
<h2>${t.gwTitle}</h2>
<p class="muted">${t.gwIntro}</p>
${rows ? `<div class="scroll"><table>\n${rows}\n</table></div>` : ""}
${suggestionsBlock}
<form method="post" action="${base}/account/gateways" id="add-server">
<input type="hidden" name="csrf" value="${csrf}">
<p><label for="gw_name">${t.gwName}</label> <input id="gw_name" name="name" required maxlength="40" placeholder="e.g. IcuSync"${preset ? ` value="${htmlEscape(preset.name)}"` : ""}><br>
<span class="muted">${t.gwNameNote}</span></p>
<p><label for="gw_url">${t.gwUrl}</label> <input id="gw_url" name="url" type="url" required placeholder="https://…"${preset ? " autofocus" : ""}><br>
<span class="muted">${t.gwUrlNote}</span>${presetUrlHint}</p>
<p><label for="gw_bearer">${t.gwBearer}</label>: <input id="gw_bearer" name="bearer" type="password" autocomplete="off"><br>
<span class="muted">${t.gwBearerNote}</span></p>
<p><label for="gw_prefix">${t.gwPrefix}</label>: <input id="gw_prefix" name="prefix" maxlength="16" pattern="[a-z0-9_]*" placeholder="${t.gwPrefixPlaceholder}"${preset ? ` value="${htmlEscape(preset.prefix)}"` : ""}><br>
<span class="muted">${t.gwPrefixNote}</span></p>
<p><button>${t.gwAdd}</button></p>
</form>
<p class="muted">${t.gwOauthNote}</p>
</div>`;
  }

  const apps = appsForEmail(ctx, user.email);
  const appsCard = apps.length
    ? `<div class="card">
<h2>${t.tools}</h2>
${apps.map((a) => `<p><a href="${base}/apps/${a.name}/">${htmlEscape(a.name)}</a></p>`).join("\n")}
</div>`
    : "";

  sendHtml(
    res,
    200,
    page(
      t.title,
      `<h1>${t.title}</h1>
<div class="card">
<h2>${t.profile}</h2>
<table>
<tr><th>${t.signedInAs}</th><td>${emailText(user.email)}</td></tr>
<tr><th>${t.memberSince}</th><td>${htmlEscape(user.created_at)} UTC</td></tr>
<tr><th>${t.lastLogin}</th><td>${htmlEscape(user.last_login_at ?? "—")} UTC</td></tr>
</table>
${telegramBlock(ctx, user, csrf, t)}
<form method="post" action="${base}/account/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="quiet">${t.signOut}</button></form>
</div>

<div class="card">
<h2>${t.yourData}</h2>
<table>
<tr><th>${t.rowSections}</th><td>${count("SELECT COUNT(*) AS n FROM sections")}</td></tr>
<tr><th>${t.rowRefs}</th><td>${count("SELECT COUNT(*) AS n FROM refs")}</td></tr>
<tr><th>${t.rowJournal}</th><td>${count("SELECT COUNT(*) AS n FROM journal")}</td></tr>
<tr><th>${t.rowOpenItems}</th><td>${count("SELECT COUNT(*) AS n FROM open_items WHERE status = 'open'")}</td></tr>
<tr><th>${t.rowRoutines}</th><td>${count("SELECT COUNT(*) AS n FROM routines")}</td></tr>
<tr><th>${t.rowDbSize}</th><td>${dbSizeKb} KB</td></tr>
<tr><th>${t.rowStorage}</th><td>${formatMb(usedBytes)} ${t.storageOf} ${formatMb(quotaBytes)} MB (${Math.round((usedBytes / quotaBytes) * 100)}%)</td></tr>
</table>
<p><a href="${base}/account/data"><button>${t.viewEdit}</button></a></p>
<form method="post" action="${base}/account/export">
<input type="hidden" name="csrf" value="${csrf}">
<button>${t.download}</button>
</form>
<p class="muted">${t.zipNote}</p>
</div>

${integrationsCard}
${gatewaysCard}
${appsCard}

<div class="card danger">
<h2>${t.dangerTitle}</h2>
<p>${t.dangerIntro}</p>
<form method="post" action="${base}/account/delete">
<input type="hidden" name="csrf" value="${csrf}">
<label for="confirm_email">${t.dangerConfirm}</label>
<input type="email" id="confirm_email" name="confirm_email" autocomplete="off" required>
<p><button class="danger">${t.dangerButton}</button></p>
</form>
</div>`,
      {
        nav: {
          base,
          active: "account",
          lang,
          signedIn: true,
          admin: isAdminEmail(user.email),
          path: presetId ? `/account?preset=${encodeURIComponent(presetId)}` : "/account",
        },
      },
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
  t: AccountStrings,
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
  await purgeUser(ctx, mcpSessions, user.id);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "set-cookie": clearedCookie(SESSION_COOKIE),
  });
  res.end(page(t.deletedTitle, `<h1>${t.deletedTitle}</h1><p>${t.deletedBody}</p>`));
}

/** UI strings for the account surface. Rare error pages deliberately stay English. */
const ACCOUNT_EN = {
  title: "Account",
  gateIntro: "Sign in to view, export, or delete the data this coaching server stores about you.",
  gateButton: "Sign in",
  profile: "Profile",
  signedInAs: "Signed in as",
  memberSince: "Member since",
  lastLogin: "Last login",
  signOut: "Sign out",
  yourData: "Your data",
  rowSections: "Knowledge sections",
  rowRefs: "Reference documents",
  rowJournal: "Journal entries",
  rowOpenItems: "Open items",
  rowRoutines: "Routines",
  rowDbSize: "Database size",
  rowStorage: "Storage used",
  storageOf: "of",
  viewEdit: "View &amp; edit your data",
  download: "Download everything (zip)",
  zipNote:
    "The zip contains every document as markdown plus a restorable copy of your database — the complete record this server holds about you.",
  integrations: "Integrations",
  connected: "connected",
  notConnected: "not connected",
  keyUpdated: "key updated",
  replaceKey: "Replace API key:",
  updateKey: "Update key",
  disconnectHevy: "Disconnect Hevy",
  hevyIntro:
    "Connect your own Hevy account (requires Hevy Pro) and your coach gains tools to read workouts and manage routines. Key: hevy.com → Settings → Developer.",
  hevyKeyLabel: "Hevy API key:",
  connectHevy: "Connect Hevy",
  keysNote:
    "Keys are stored encrypted, are never shown again, and are removed with your account. New Claude conversations pick changes up immediately.",
  telegramIntro:
    "Connect the server's Telegram bot: it notifies you about your access and storage quota, your coach can push scheduled check-in summaries to your phone, and anything you text the bot lands in your coaching journal for the next session.",
  telegramConnect: "Connect on Telegram →",
  telegramUnlink: "Disconnect Telegram",
  gwTitle: "Connected MCP servers",
  gwIntro:
    "Attach other MCP servers here and their tools appear in your coaching conversations — so one Claude connector is enough even on plans that allow only one. You sign in to each server as yourself (your own account and subscription there); credentials are stored encrypted, never shown again, and removed with your account.",
  gwSuggested: "Suggested:",
  gwGetUrlAt: "Get your personal MCP URL at",
  gwThen: ", then",
  gwPrefill: "prefill the form below",
  gwTools: "tools:",
  gwSealedQuery: "embedded access token stored encrypted",
  gwStatusConnected: "connected",
  gwStatusNeedsAuth: "sign-in required",
  gwStatusError: "error",
  gwStatusNew: "not connected yet",
  gwRecheck: "Re-check",
  gwConnect: "Connect",
  gwRemove: "Remove",
  gwName: "Name:",
  gwNameNote: "A label for this list — it does not change any tool names.",
  gwUrl: "Server URL:",
  gwUrlNote:
    "Paste the URL exactly as the service gives it. If it already contains an access token (e.g. <code>…/mcp?token=…</code>), that is all you need — the token part is split off and stored encrypted.",
  gwBearer: "Access token",
  gwBearerNote:
    "Only for servers that expect a separate Authorization header. Leave empty when the token is already part of the URL, or when the server signs you in itself.",
  gwPrefix: "Tool prefix",
  gwPrefixPlaceholder: "defaults to the name",
  gwPrefixNote:
    "This server's tools appear as <code>prefix_toolname</code> so you can always tell which server a tool comes from (e.g. <code>icusync_get_activities</code>). Left empty, it is derived from the name. Must be unique among your servers; a–z, 0–9, _.",
  gwAdd: "Add &amp; connect",
  gwOauthNote:
    "Servers with their own sign-in open an authorization page — like adding a connector in Claude. New Claude conversations pick up the tools immediately.",
  tools: "Tools",
  dangerTitle: "Danger zone",
  dangerIntro:
    "Deleting your account immediately and irreversibly removes your coaching database and revokes all connected clients. Operator backups expire on the deployment's own retention schedule.",
  dangerConfirm: "Type your email address to confirm:",
  dangerButton: "Delete my account and all data",
  deletedTitle: "Account deleted",
  deletedBody:
    "Your coaching data has been removed and all connected clients signed out. Signing in again would start a fresh, empty account.",
};

export type AccountStrings = typeof ACCOUNT_EN;

const ACCOUNT_DE: AccountStrings = {
  title: "Account",
  gateIntro:
    "Melde dich an, um die Daten einzusehen, zu exportieren oder zu löschen, die dieser Coaching-Server über dich speichert.",
  gateButton: "Anmelden",
  profile: "Profil",
  signedInAs: "Angemeldet als",
  memberSince: "Mitglied seit",
  lastLogin: "Letzter Login",
  signOut: "Abmelden",
  yourData: "Deine Daten",
  rowSections: "Wissens-Sektionen",
  rowRefs: "Referenzdokumente",
  rowJournal: "Journaleinträge",
  rowOpenItems: "Offene Punkte",
  rowRoutines: "Routinen",
  rowDbSize: "Datenbankgröße",
  rowStorage: "Speicher belegt",
  storageOf: "von",
  viewEdit: "Daten ansehen &amp; bearbeiten",
  download: "Alles herunterladen (zip)",
  zipNote:
    "Das Zip enthält jedes Dokument als Markdown plus eine wiederherstellbare Kopie deiner Datenbank — alles, was dieser Server über dich speichert.",
  integrations: "Integrationen",
  connected: "verbunden",
  notConnected: "nicht verbunden",
  keyUpdated: "Key aktualisiert",
  replaceKey: "API-Key ersetzen:",
  updateKey: "Key aktualisieren",
  disconnectHevy: "Hevy trennen",
  hevyIntro:
    "Verbinde dein eigenes Hevy-Konto (erfordert Hevy Pro), dann kann dein Coach Workouts lesen und Routinen verwalten. Key: hevy.com → Settings → Developer.",
  hevyKeyLabel: "Hevy-API-Key:",
  connectHevy: "Hevy verbinden",
  keysNote:
    "Keys werden verschlüsselt gespeichert, nie wieder angezeigt und mit deinem Account gelöscht. Neue Claude-Unterhaltungen übernehmen Änderungen sofort.",
  telegramIntro:
    "Verbinde den Telegram-Bot dieses Servers: er informiert dich über Zugang und Speicherkontingent, dein Coach kann geplante Check-in-Zusammenfassungen aufs Handy schicken, und alles, was du dem Bot schreibst, landet für die nächste Session in deinem Coaching-Journal.",
  telegramConnect: "Auf Telegram verbinden →",
  telegramUnlink: "Telegram trennen",
  gwTitle: "Verbundene MCP-Server",
  gwIntro:
    "Hänge hier weitere MCP-Server an, dann stehen ihre Tools in deinen Coaching-Unterhaltungen bereit — ein Claude-Connector genügt, auch in Tarifen, die nur einen erlauben. Du meldest dich bei jedem Server als du selbst an (eigenes Konto und Abo dort); Zugangsdaten werden verschlüsselt gespeichert, nie wieder angezeigt und mit deinem Account gelöscht.",
  gwSuggested: "Vorschläge:",
  gwGetUrlAt: "Hol dir deine persönliche MCP-URL auf",
  gwThen: ", dann",
  gwPrefill: "Formular unten vorbefüllen",
  gwTools: "Tools:",
  gwSealedQuery: "eingebettetes Zugriffstoken verschlüsselt gespeichert",
  gwStatusConnected: "verbunden",
  gwStatusNeedsAuth: "Anmeldung erforderlich",
  gwStatusError: "Fehler",
  gwStatusNew: "noch nicht verbunden",
  gwRecheck: "Neu prüfen",
  gwConnect: "Verbinden",
  gwRemove: "Entfernen",
  gwName: "Name:",
  gwNameNote: "Nur eine Bezeichnung für diese Liste — ändert keine Tool-Namen.",
  gwUrl: "Server-URL:",
  gwUrlNote:
    "Füge die URL genau so ein, wie der Dienst sie dir gibt. Enthält sie bereits ein Zugriffstoken (z. B. <code>…/mcp?token=…</code>), reicht das — der Token-Teil wird abgetrennt und verschlüsselt gespeichert.",
  gwBearer: "Zugriffstoken",
  gwBearerNote:
    "Nur für Server, die einen separaten Authorization-Header erwarten. Leer lassen, wenn das Token Teil der URL ist oder der Server dich selbst anmeldet.",
  gwPrefix: "Tool-Präfix",
  gwPrefixPlaceholder: "wird aus dem Namen abgeleitet",
  gwPrefixNote:
    "Die Tools dieses Servers erscheinen als <code>prefix_toolname</code>, damit immer erkennbar ist, von welchem Server ein Tool stammt (z. B. <code>icusync_get_activities</code>). Leer gelassen wird das Präfix aus dem Namen abgeleitet. Muss unter deinen Servern eindeutig sein; a–z, 0–9, _.",
  gwAdd: "Hinzufügen &amp; verbinden",
  gwOauthNote:
    "Server mit eigener Anmeldung öffnen eine Autorisierungsseite — wie beim Hinzufügen eines Connectors in Claude. Neue Claude-Unterhaltungen übernehmen die Tools sofort.",
  tools: "Tools",
  dangerTitle: "Gefahrenzone",
  dangerIntro:
    "Das Löschen deines Accounts entfernt sofort und unwiderruflich deine Coaching-Datenbank und meldet alle verbundenen Clients ab. Betreiber-Backups laufen nach dem Aufbewahrungsplan des Deployments aus.",
  dangerConfirm: "Zur Bestätigung deine E-Mail-Adresse eintippen:",
  dangerButton: "Meinen Account und alle Daten löschen",
  deletedTitle: "Account gelöscht",
  deletedBody:
    "Deine Coaching-Daten wurden entfernt und alle verbundenen Clients abgemeldet. Eine erneute Anmeldung würde einen frischen, leeren Account anlegen.",
};
