import type Database from "better-sqlite3";
import type { ServerResponse } from "node:http";
import type { WebAuth } from "./account.js";
import { getUser } from "./auth/db.js";
import type { ServeContext } from "./context.js";
import { type ChangeKind, type ChangeRow, logReplace } from "./history.js";
import { htmlEscape, redirect, sendHtml } from "./http-util.js";
import { renderMarkdown } from "./markdown.js";
import { checkWrite, DOC_MAX_BYTES, ENTRY_MAX_BYTES, quotaBytesForUser } from "./quota.js";
import type { Lang } from "./web/i18n.js";
import { type NavOpts, page } from "./web/layout.js";

/**
 * Browse & edit area under /account/data: every document the server stores
 * about the signed-in user — sections, references, journal entries, open
 * items, routines — viewable and editable in the browser, without a coaching
 * session. The routines view doubles as the copy source for pasting a stored
 * prompt into a Claude scheduled task.
 *
 * Server-rendered like the rest of the account surface. UI strings are
 * bilingual (DATA_EN / DATA_DE below); rare error pages deliberately stay
 * English. Every page carries a left sidebar (dataShell) for moving between
 * the data views. Content is shown in textareas/<pre> (it is markdown
 * authored for an LLM — no HTML rendering, no XSS surface).
 * Section/reference saves carry the row's `updated_at` as an
 * optimistic-concurrency token so a concurrent MCP write is never silently
 * clobbered.
 */

const DOC_TABLES = { section: "sections", reference: "refs" } as const;
type DocType = keyof typeof DOC_TABLES;

type DocRow = { name: string; content: string; updated_at: string };
type JournalRow = { id: number; entry: string; created_at: string };
type ItemRow = {
  id: number;
  kind: string;
  content: string;
  status: string;
  relevant_date: string | null;
  created_at: string;
};
type RoutineRow = {
  name: string;
  cadence: string;
  prompt: string;
  status: string;
  updated_at: string;
};

const ROUTINE_STATUSES = ["active", "paused", "retired"];

const JOURNAL_PAGE_SIZE = 20;

function docType(value: string | null): DocType | undefined {
  return value === "section" || value === "reference" ? value : undefined;
}

function isValidDocName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 128 &&
    name === name.trim() &&
    // oxlint-disable-next-line no-control-regex -- rejecting control chars is the point
    !/[\x00-\x1f\x7f]/.test(name)
  );
}

/** Breadcrumb for error pages only — regular pages carry the sidebar instead. */
function backBar(base: string, label = "Your data", href = "/account/data"): string {
  return `<p class="muted"><a href="${base}/account">Account</a> › <a href="${base}${href}">${htmlEscape(label)}</a></p>`;
}

function errorPage(res: ServerResponse, status: number, title: string, body: string): void {
  sendHtml(res, status, page(title, `<h1>${htmlEscape(title)}</h1>${body}`));
}

/**
 * Web-editor mirror of the MCP write guards: per-document caps + total quota.
 * No write rate limit here — browser edits are human-paced. Returns true when
 * the write was refused (response already sent).
 */
function refuseOversizedWrite(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  db: Database.Database,
  opts: { docBytes: number; docMax: number; deltaBytes: number },
): boolean {
  const user = getUser(ctx.authDb, auth.userId);
  const refusal = checkWrite(
    db,
    { quotaBytes: quotaBytesForUser(user, ctx.cfg.quotaDefaultMb), allowWrite: () => true },
    opts,
  );
  if (!refusal) return false;
  errorPage(
    res,
    413,
    "Storage limit",
    `<p>${htmlEscape(refusal)}</p><p>Your edit was <strong>not</strong> saved.</p>`,
  );
  return true;
}

/** Fill %PLACEHOLDER% slots; the function replacer keeps `$` in values literal. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/%([A-Z]+)%/g, (match, key: string) => vars[key] ?? match);
}

type DataNav = "overview" | "journal" | "open-items" | "routines" | "history";

/** Left sidebar shared by every data page; the anchor links are never "active". */
function dataShell(base: string, active: DataNav, t: typeof DATA_EN, body: string): string {
  const item = (key: DataNav | null, href: string, label: string): string =>
    `<a href="${href}"${key !== null && key === active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<div class="withside"><aside class="side">
${item("overview", `${base}/account/data`, t.navOverview)}
${item(null, `${base}/account/data#sections`, t.navSections)}
${item(null, `${base}/account/data#references`, t.navReferences)}
${item("journal", `${base}/account/data/journal`, t.navJournal)}
${item("open-items", `${base}/account/data/open-items`, t.navOpenItems)}
${item("routines", `${base}/account/data/routines`, t.navRoutines)}
${item("history", `${base}/account/data/history`, t.navHistory)}
</aside><div class="content">${body}</div></div>`;
}

/** Header nav opts for a data page; `path` feeds the DE/EN toggle. */
function dataNav(base: string, lang: Lang, path: string): NavOpts {
  return { base, active: "data", lang, signedIn: true, path };
}

// ---------------------------------------------------------------------------
// GET routes

export function handleDataGet(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
): boolean {
  const path = url.pathname;
  switch (path) {
    case "/account/data":
      renderOverview(ctx, res, auth, lang);
      return true;
    case "/account/data/doc":
      renderDocEditor(ctx, res, auth, url, lang);
      return true;
    case "/account/data/new":
      renderDocEditor(ctx, res, auth, url, lang, { isNew: true });
      return true;
    case "/account/data/journal":
      renderJournal(ctx, res, auth, url, lang);
      return true;
    case "/account/data/journal/edit":
      renderJournalEditor(ctx, res, auth, url, lang);
      return true;
    case "/account/data/open-items":
      renderOpenItems(ctx, res, auth, lang);
      return true;
    case "/account/data/open-items/edit":
      renderOpenItemEditor(ctx, res, auth, url, lang);
      return true;
    case "/account/data/routines":
      renderRoutines(ctx, res, auth, lang);
      return true;
    case "/account/data/routines/edit":
      renderRoutineEditor(ctx, res, auth, url, lang);
      return true;
    case "/account/data/routines/new":
      renderRoutineEditor(ctx, res, auth, url, lang, { isNew: true });
      return true;
    case "/account/data/history":
      renderHistory(ctx, res, auth, url, lang);
      return true;
    default:
      return false;
  }
}

function renderOverview(ctx: ServeContext, res: ServerResponse, auth: WebAuth, lang: Lang): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);

  const docTable = (type: DocType): string => {
    const rows = db
      .prepare(`SELECT name, content, updated_at FROM ${DOC_TABLES[type]} ORDER BY name`)
      .all() as DocRow[];
    const body = rows
      .map(
        (r) =>
          `<tr><td><a href="${base}/account/data/doc?type=${type}&amp;name=${encodeURIComponent(r.name)}">${htmlEscape(r.name)}</a></td>` +
          `<td>${htmlEscape(r.updated_at)}</td><td>${Math.max(1, Math.round(r.content.length / 1024))} KB</td></tr>`,
      )
      .join("\n");
    return `<table><tr><th>${t.thName}</th><th>${t.thUpdated}</th><th>${t.thSize}</th></tr>${body || `<tr><td colspan="3" class="muted">${t.none}</td></tr>`}</table>
<p><a href="${base}/account/data/new?type=${type}"><button>${type === "section" ? t.newSection : t.newReference}</button></a></p>`;
  };

  const journalCount = (db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n;
  const openCount = (
    db.prepare("SELECT COUNT(*) AS n FROM open_items WHERE status = 'open'").get() as {
      n: number;
    }
  ).n;
  const itemCount = (db.prepare("SELECT COUNT(*) AS n FROM open_items").get() as { n: number }).n;
  const routineCount = (db.prepare("SELECT COUNT(*) AS n FROM routines").get() as { n: number }).n;

  const body = `<h1>${t.title}</h1>
<div class="card" id="sections"><h2>${t.sectionsTitle}</h2><p class="muted">${t.sectionsHint}</p>${docTable("section")}</div>
<div class="card" id="references"><h2>${t.refsTitle}</h2>${docTable("reference")}</div>
<div class="card"><h2>${t.journalTitle}</h2><p>${fill(t.journalCount, { N: String(journalCount) })} — <a href="${base}/account/data/journal">${t.browseEdit}</a></p></div>
<div class="card"><h2>${t.openItemsTitle}</h2><p>${fill(t.openSummary, { OPEN: String(openCount), TOTAL: String(itemCount) })} — <a href="${base}/account/data/open-items">${t.manage}</a></p></div>
<div class="card"><h2>${t.routinesTitle}</h2><p>${fill(t.routinesStored, { N: String(routineCount) })} — <a href="${base}/account/data/routines">${t.viewCopy}</a></p><p class="muted">${t.routinesHint}</p></div>`;

  sendHtml(
    res,
    200,
    page(t.title, dataShell(base, "overview", t, body), {
      nav: dataNav(base, lang, "/account/data"),
    }),
  );
}

function renderDocEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
  { isNew = false }: { isNew?: boolean } = {},
): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const type = docType(url.searchParams.get("type"));
  if (!type) {
    errorPage(res, 400, "Invalid request", "<p>Unknown document type.</p>");
    return;
  }
  const db = ctx.tenants.open(auth.userId);
  const csrf = htmlEscape(auth.csrf);

  let row: DocRow | undefined;
  if (!isNew) {
    const name = url.searchParams.get("name") ?? "";
    row = db
      .prepare(`SELECT name, content, updated_at FROM ${DOC_TABLES[type]} WHERE name = ?`)
      .get(name) as DocRow | undefined;
    if (!row) {
      errorPage(
        res,
        404,
        "Not found",
        `<p>No ${type} named <code>${htmlEscape(name)}</code>.</p>${backBar(base)}`,
      );
      return;
    }
  }

  const saved = url.searchParams.get("saved") === "1";
  const protectedMain = type === "section" && row?.name === "main";
  const typeLabel = type === "section" ? t.typeSection : t.typeReference;
  const newLabel = type === "section" ? t.newSection : t.newReference;
  const nameField = row
    ? `<input type="hidden" name="name" value="${htmlEscape(row.name)}"><code>${htmlEscape(row.name)}</code>`
    : `<input type="text" name="name" placeholder="${t.docNamePlaceholder}" required>`;
  const deleteForm =
    row && !protectedMain
      ? `<form method="post" action="${base}/account/data/doc/delete">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="type" value="${type}"><input type="hidden" name="name" value="${htmlEscape(row.name)}">
<button class="danger">${fill(t.deleteDoc, { TYPE: typeLabel })}</button></form>`
      : protectedMain
        ? `<p class="muted">${t.mainProtected}</p>`
        : "";

  const previewColumn = row
    ? `<div>
<p class="muted">${t.previewHint}</p>
<div class="preview">${renderMarkdown(row.content)}</div>
</div>`
    : "";

  const body = `<h1>${row ? `${typeLabel}: ${htmlEscape(row.name)}` : newLabel}</h1>
${saved ? `<p class="muted">${t.savedNotice}</p>` : ""}
${row ? `<p class="muted">${fill(t.lastUpdated, { TS: htmlEscape(row.updated_at) })} · <a href="${historyHref(base, type === "section" ? "section" : "ref", row.name)}">${t.historyLink}</a></p>` : ""}
<div class="split">
<div>
<form method="post" action="${base}/account/data/doc/save">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="type" value="${type}">
<input type="hidden" name="expected_updated_at" value="${htmlEscape(row?.updated_at ?? "")}">
<p>${nameField}</p>
<textarea name="content" class="editor">${htmlEscape(row?.content ?? "")}</textarea>
<p><button>${t.save}</button></p>
</form>
${deleteForm}
</div>
${previewColumn}
</div>`;

  const path = row
    ? `/account/data/doc?type=${type}&name=${encodeURIComponent(row.name)}`
    : `/account/data/new?type=${type}`;
  sendHtml(
    res,
    200,
    page(row ? `${typeLabel}: ${row.name}` : newLabel, dataShell(base, "overview", t, body), {
      wide: true,
      nav: dataNav(base, lang, path),
    }),
  );
}

function renderJournal(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const pageNo = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);
  const total = (db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n;
  const rows = db
    .prepare(
      "SELECT id, entry, created_at FROM journal ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(JOURNAL_PAGE_SIZE, pageNo * JOURNAL_PAGE_SIZE) as JournalRow[];

  const entries = rows
    .map(
      (r) =>
        `<div class="card"><p class="muted">${htmlEscape(r.created_at)} UTC — <a href="${base}/account/data/journal/edit?id=${r.id}">${t.edit}</a></p>
<div class="preview">${renderMarkdown(r.entry)}</div></div>`,
    )
    .join("\n");
  const pager = [
    pageNo > 0 ? `<a href="${base}/account/data/journal?page=${pageNo - 1}">${t.newer}</a>` : "",
    (pageNo + 1) * JOURNAL_PAGE_SIZE < total
      ? `<a href="${base}/account/data/journal?page=${pageNo + 1}">${t.older}</a>`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const body = `<h1>${t.journalTitle}</h1>
<p class="muted">${fill(t.journalIntro, { TOTAL: String(total) })}</p>
${entries || `<p class="muted">${t.noEntries}</p>`}
<p>${pager}</p>`;

  sendHtml(
    res,
    200,
    page(t.journalTitle, dataShell(base, "journal", t, body), {
      nav: dataNav(base, lang, `/account/data/journal${pageNo > 0 ? `?page=${pageNo}` : ""}`),
    }),
  );
}

function renderJournalEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const id = Number(url.searchParams.get("id"));
  const row = db.prepare("SELECT id, entry, created_at FROM journal WHERE id = ?").get(id) as
    | JournalRow
    | undefined;
  if (!row) {
    errorPage(
      res,
      404,
      "Not found",
      `<p>No journal entry #${htmlEscape(String(id))}.</p>${backBar(base, "Journal", "/account/data/journal")}`,
    );
    return;
  }
  const csrf = htmlEscape(auth.csrf);
  const title = fill(t.journalEntryTitle, { ID: String(row.id) });
  const body = `<h1>${title}</h1>
<p class="muted">${fill(t.journalWritten, { TS: htmlEscape(row.created_at) })} · <a href="${historyHref(base, "journal", String(row.id))}">${t.historyLink}</a></p>
<div class="split">
<div>
<form method="post" action="${base}/account/data/journal/save">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<textarea name="entry" class="editor short">${htmlEscape(row.entry)}</textarea>
<p><button>${t.save}</button></p>
</form>
<form method="post" action="${base}/account/data/journal/delete">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<button class="danger">${t.deleteEntry}</button></form>
</div>
<div>
<p class="muted">${t.previewHint}</p>
<div class="preview">${renderMarkdown(row.entry)}</div>
</div>
</div>`;
  sendHtml(
    res,
    200,
    page(title, dataShell(base, "journal", t, body), {
      wide: true,
      nav: dataNav(base, lang, `/account/data/journal/edit?id=${row.id}`),
    }),
  );
}

function renderOpenItems(ctx: ServeContext, res: ServerResponse, auth: WebAuth, lang: Lang): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const rows = db
    .prepare(
      "SELECT id, kind, content, status, relevant_date, created_at FROM open_items ORDER BY (status != 'open'), id DESC",
    )
    .all() as ItemRow[];
  const items = rows
    .map(
      (r) =>
        `<div class="card"><p class="muted">#${r.id} [${htmlEscape(r.kind)}] · ${htmlEscape(r.status)}${r.relevant_date ? ` · ${htmlEscape(r.relevant_date)}` : ""} — <a href="${base}/account/data/open-items/edit?id=${r.id}">${t.edit}</a></p>
<div class="preview">${renderMarkdown(r.content)}</div></div>`,
    )
    .join("\n");
  const body = `<h1>${t.openItemsTitle}</h1>
<p class="muted">${t.openItemsIntro}</p>
${items || `<p class="muted">${t.none}</p>`}`;
  sendHtml(
    res,
    200,
    page(t.openItemsTitle, dataShell(base, "open-items", t, body), {
      nav: dataNav(base, lang, "/account/data/open-items"),
    }),
  );
}

function renderOpenItemEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const id = Number(url.searchParams.get("id"));
  const row = db
    .prepare(
      "SELECT id, kind, content, status, relevant_date, created_at FROM open_items WHERE id = ?",
    )
    .get(id) as ItemRow | undefined;
  if (!row) {
    errorPage(
      res,
      404,
      "Not found",
      `<p>No open item #${htmlEscape(String(id))}.</p>${backBar(base, "Open items", "/account/data/open-items")}`,
    );
    return;
  }
  const csrf = htmlEscape(auth.csrf);
  const statusOption = (s: string): string =>
    `<option value="${s}"${row.status === s ? " selected" : ""}>${s}</option>`;
  const title = fill(t.openItemTitle, { ID: String(row.id) });
  const body = `<h1>${title} <span class="muted">[${htmlEscape(row.kind)}]</span></h1>
<p class="muted">${fill(t.created, { TS: htmlEscape(row.created_at) })}</p>
<form method="post" action="${base}/account/data/open-items/save">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<textarea name="content" rows="6" class="mono">${htmlEscape(row.content)}</textarea>
<p><label>${t.statusLabel}
<select name="status">${statusOption("open")}${statusOption("done")}${statusOption("dismissed")}</select></label></p>
<p><label>${t.relevantDate} <input type="text" name="relevant_date" value="${htmlEscape(row.relevant_date ?? "")}" placeholder="${t.datePlaceholder}"></label></p>
<p><button>${t.save}</button></p>
</form>
<form method="post" action="${base}/account/data/open-items/delete">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<button class="danger">${t.deleteItem}</button></form>`;
  sendHtml(
    res,
    200,
    page(title, dataShell(base, "open-items", t, body), {
      nav: dataNav(base, lang, `/account/data/open-items/edit?id=${row.id}`),
    }),
  );
}

function renderRoutines(ctx: ServeContext, res: ServerResponse, auth: WebAuth, lang: Lang): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const rows = db
    .prepare(
      "SELECT name, cadence, prompt, status, updated_at FROM routines ORDER BY (status != 'active'), name",
    )
    .all() as RoutineRow[];
  const items = rows
    .map(
      (r) =>
        `<div class="card"><p><strong>${htmlEscape(r.name)}</strong> <span class="muted">[${htmlEscape(r.status)}] · ${htmlEscape(r.cadence)}</span> — <a href="${base}/account/data/routines/edit?name=${encodeURIComponent(r.name)}">${t.open}</a></p></div>`,
    )
    .join("\n");
  const body = `<h1>${t.routinesTitle}</h1>
<p class="muted">${t.routinesIntro}</p>
${items || `<p class="muted">${t.noRoutines}</p>`}
<p><a href="${base}/account/data/routines/new"><button>${t.newRoutine}</button></a></p>`;
  sendHtml(
    res,
    200,
    page(t.routinesTitle, dataShell(base, "routines", t, body), {
      nav: dataNav(base, lang, "/account/data/routines"),
    }),
  );
}

function renderRoutineEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
  { isNew = false }: { isNew?: boolean } = {},
): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const csrf = htmlEscape(auth.csrf);

  let row: RoutineRow | undefined;
  if (!isNew) {
    const name = url.searchParams.get("name") ?? "";
    row = db
      .prepare("SELECT name, cadence, prompt, status, updated_at FROM routines WHERE name = ?")
      .get(name) as RoutineRow | undefined;
    if (!row) {
      errorPage(
        res,
        404,
        "Not found",
        `<p>No routine named <code>${htmlEscape(name)}</code>.</p>${backBar(base, "Routines", "/account/data/routines")}`,
      );
      return;
    }
  }

  const saved = url.searchParams.get("saved") === "1";
  const nameField = row
    ? `<input type="hidden" name="name" value="${htmlEscape(row.name)}"><code>${htmlEscape(row.name)}</code>`
    : `<input type="text" name="name" placeholder="${t.routineNamePlaceholder}" required>`;
  const statusOption = (s: string): string =>
    `<option value="${s}"${(row?.status ?? "active") === s ? " selected" : ""}>${s}</option>`;
  const deleteForm = row
    ? `<form method="post" action="${base}/account/data/routines/delete">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="name" value="${htmlEscape(row.name)}">
<button class="danger">${t.deleteRoutine}</button></form>`
    : "";

  const body = `<h1>${row ? `${t.routineWord}: ${htmlEscape(row.name)}` : t.newRoutine}</h1>
${saved ? `<p class="muted">${t.routineSaved}</p>` : ""}
${row ? `<p class="muted">${fill(t.routineMeta, { TS: htmlEscape(row.updated_at), STATUS: htmlEscape(row.status), CADENCE: htmlEscape(row.cadence) })} · <a href="${historyHref(base, "routine", row.name)}">${t.historyLink}</a></p>` : ""}
<p class="muted">${t.routineCopyHint}</p>
<form method="post" action="${base}/account/data/routines/save">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="expected_updated_at" value="${htmlEscape(row?.updated_at ?? "")}">
<p>${nameField}</p>
<p><label>${t.cadenceLabel} <input type="text" name="cadence" value="${htmlEscape(row?.cadence ?? "")}" placeholder="${t.cadencePlaceholder}" required></label></p>
<p><label>${t.statusLabel}
<select name="status">${ROUTINE_STATUSES.map(statusOption).join("")}</select></label>
<span class="muted">${t.statusHint}</span></p>
<textarea name="prompt" class="editor">${htmlEscape(row?.prompt ?? "")}</textarea>
<p><button>${t.save}</button></p>
</form>
${deleteForm}`;

  const path = row
    ? `/account/data/routines/edit?name=${encodeURIComponent(row.name)}`
    : "/account/data/routines/new";
  sendHtml(
    res,
    200,
    page(
      row ? `${t.routineWord}: ${row.name}` : t.newRoutine,
      dataShell(base, "routines", t, body),
      { wide: true, nav: dataNav(base, lang, path) },
    ),
  );
}

// ---------------------------------------------------------------------------
// POST routes (session + CSRF already verified by the account router)

export function handleDataPost(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  form: URLSearchParams,
): boolean {
  switch (url.pathname) {
    case "/account/data/doc/save":
      saveDoc(ctx, res, auth, form);
      return true;
    case "/account/data/doc/delete":
      deleteDoc(ctx, res, auth, form);
      return true;
    case "/account/data/journal/save":
      saveJournal(ctx, res, auth, form);
      return true;
    case "/account/data/journal/delete":
      deleteJournal(ctx, res, auth, form);
      return true;
    case "/account/data/open-items/save":
      saveOpenItem(ctx, res, auth, form);
      return true;
    case "/account/data/open-items/delete":
      deleteOpenItem(ctx, res, auth, form);
      return true;
    case "/account/data/routines/save":
      saveRoutine(ctx, res, auth, form);
      return true;
    case "/account/data/routines/delete":
      deleteRoutine(ctx, res, auth, form);
      return true;
    case "/account/data/history/restore":
      restoreDeletedDoc(ctx, res, auth, form);
      return true;
    case "/account/data/history/purge":
      purgeHistory(ctx, res, auth, form);
      return true;
    default:
      return false;
  }
}

function saveDoc(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const base = ctx.cfg.publicUrl;
  const type = docType(form.get("type"));
  const name = form.get("name") ?? "";
  const content = form.get("content") ?? "";
  const expected = form.get("expected_updated_at") ?? "";
  if (!type || !isValidDocName(name)) {
    errorPage(res, 400, "Invalid request", "<p>Invalid document type or name.</p>");
    return;
  }
  const db = ctx.tenants.open(auth.userId);
  const table = DOC_TABLES[type];
  const existingLen =
    (
      db.prepare(`SELECT LENGTH(content) AS n FROM ${table} WHERE name = ?`).get(name) as
        | { n: number }
        | undefined
    )?.n ?? 0;
  if (
    refuseOversizedWrite(ctx, res, auth, db, {
      docBytes: content.length,
      docMax: DOC_MAX_BYTES,
      deltaBytes: content.length - existingLen,
    })
  ) {
    return;
  }

  if (expected === "") {
    // create: refuse to clobber an existing doc of the same name
    try {
      db.prepare(`INSERT INTO ${table} (name, content) VALUES (?, ?)`).run(name, content);
    } catch {
      errorPage(
        res,
        409,
        "Name already exists",
        `<p>A ${type} named <code>${htmlEscape(name)}</code> already exists. <a href="${base}/account/data/doc?type=${type}&amp;name=${encodeURIComponent(name)}">Open it</a> to edit.</p>`,
      );
      return;
    }
  } else {
    // update, guarded against a concurrent edit (e.g. from a coaching session)
    let conflict = false;
    db.transaction(() => {
      const old = (
        db.prepare(`SELECT content FROM ${table} WHERE name = ?`).get(name) as
          | { content: string }
          | undefined
      )?.content;
      const result = db
        .prepare(
          `UPDATE ${table} SET content = ?, updated_at = datetime('now') WHERE name = ? AND updated_at = ?`,
        )
        .run(content, name, expected);
      if (result.changes === 0 || old === undefined) {
        conflict = true;
        return;
      }
      logReplace(db, type === "section" ? "section" : "ref", name, old, content, "web");
    })();
    if (conflict) {
      errorPage(
        res,
        409,
        "Edit conflict",
        `<p>This ${type} changed since you opened it — most likely a coaching session updated it. Your edit was <strong>not</strong> saved.</p>
<p><a href="${base}/account/data/doc?type=${type}&amp;name=${encodeURIComponent(name)}">Reload the current version</a> and re-apply your change.</p>`,
      );
      return;
    }
  }
  redirect(res, `${base}/account/data/doc?type=${type}&name=${encodeURIComponent(name)}&saved=1`);
}

function deleteDoc(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const base = ctx.cfg.publicUrl;
  const type = docType(form.get("type"));
  const name = form.get("name") ?? "";
  if (!type) {
    errorPage(res, 400, "Invalid request", "<p>Unknown document type.</p>");
    return;
  }
  if (type === "section" && name === "main") {
    errorPage(
      res,
      400,
      "Not allowed",
      "<p>The <code>main</code> section is the canonical SKILL.md and cannot be deleted.</p>",
    );
    return;
  }
  const db = ctx.tenants.open(auth.userId);
  db.prepare(`DELETE FROM ${DOC_TABLES[type]} WHERE name = ?`).run(name);
  redirect(res, `${base}/account/data`);
}

function saveJournal(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const base = ctx.cfg.publicUrl;
  const id = Number(form.get("id"));
  const entry = form.get("entry") ?? "";
  const db = ctx.tenants.open(auth.userId);
  const old = (
    db.prepare("SELECT entry FROM journal WHERE id = ?").get(id) as { entry: string } | undefined
  )?.entry;
  if (old === undefined) {
    errorPage(res, 404, "Not found", `<p>No journal entry #${htmlEscape(String(id))}.</p>`);
    return;
  }
  if (
    refuseOversizedWrite(ctx, res, auth, db, {
      docBytes: entry.length,
      docMax: ENTRY_MAX_BYTES,
      deltaBytes: entry.length - old.length,
    })
  ) {
    return;
  }
  // created_at is intentionally preserved: the edit corrects content, not history
  db.transaction(() => {
    db.prepare("UPDATE journal SET entry = ? WHERE id = ?").run(entry, id);
    logReplace(db, "journal", String(id), old, entry, "web");
  })();
  redirect(res, `${base}/account/data/journal`);
}

function deleteJournal(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const db = ctx.tenants.open(auth.userId);
  db.prepare("DELETE FROM journal WHERE id = ?").run(Number(form.get("id")));
  redirect(res, `${ctx.cfg.publicUrl}/account/data/journal`);
}

function saveOpenItem(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const base = ctx.cfg.publicUrl;
  const id = Number(form.get("id"));
  const content = form.get("content") ?? "";
  const status = form.get("status") ?? "";
  const relevantDate = (form.get("relevant_date") ?? "").trim();
  if (!["open", "done", "dismissed"].includes(status)) {
    errorPage(res, 400, "Invalid request", "<p>Unknown status.</p>");
    return;
  }
  const db = ctx.tenants.open(auth.userId);
  const oldLen =
    (
      db.prepare("SELECT LENGTH(content) AS n FROM open_items WHERE id = ?").get(id) as
        | { n: number }
        | undefined
    )?.n ?? 0;
  if (
    refuseOversizedWrite(ctx, res, auth, db, {
      docBytes: content.length,
      docMax: ENTRY_MAX_BYTES,
      deltaBytes: content.length - oldLen,
    })
  ) {
    return;
  }
  const result = db
    .prepare(
      "UPDATE open_items SET content = ?, status = ?, relevant_date = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(content, status, relevantDate || null, id);
  if (result.changes === 0) {
    errorPage(res, 404, "Not found", `<p>No open item #${htmlEscape(String(id))}.</p>`);
    return;
  }
  redirect(res, `${base}/account/data/open-items`);
}

function deleteOpenItem(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const db = ctx.tenants.open(auth.userId);
  db.prepare("DELETE FROM open_items WHERE id = ?").run(Number(form.get("id")));
  redirect(res, `${ctx.cfg.publicUrl}/account/data/open-items`);
}

function saveRoutine(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const base = ctx.cfg.publicUrl;
  const name = form.get("name") ?? "";
  const cadence = (form.get("cadence") ?? "").trim();
  const prompt = form.get("prompt") ?? "";
  const status = form.get("status") ?? "";
  const expected = form.get("expected_updated_at") ?? "";
  if (!isValidDocName(name) || cadence === "" || !ROUTINE_STATUSES.includes(status)) {
    errorPage(res, 400, "Invalid request", "<p>Invalid routine name, cadence, or status.</p>");
    return;
  }
  const db = ctx.tenants.open(auth.userId);
  const oldPrompt = (
    db.prepare("SELECT prompt FROM routines WHERE name = ?").get(name) as
      | { prompt: string }
      | undefined
  )?.prompt;
  if (
    refuseOversizedWrite(ctx, res, auth, db, {
      docBytes: prompt.length,
      docMax: ENTRY_MAX_BYTES,
      deltaBytes: prompt.length - (oldPrompt?.length ?? 0),
    })
  ) {
    return;
  }

  if (expected === "") {
    // create: refuse to clobber an existing routine of the same name
    try {
      db.prepare("INSERT INTO routines (name, cadence, prompt, status) VALUES (?, ?, ?, ?)").run(
        name,
        cadence,
        prompt,
        status,
      );
    } catch {
      errorPage(
        res,
        409,
        "Name already exists",
        `<p>A routine named <code>${htmlEscape(name)}</code> already exists. <a href="${base}/account/data/routines/edit?name=${encodeURIComponent(name)}">Open it</a> to edit.</p>`,
      );
      return;
    }
  } else {
    // update, guarded against a concurrent edit (e.g. from a coaching session)
    let conflict = false;
    db.transaction(() => {
      const result = db
        .prepare(
          "UPDATE routines SET cadence = ?, prompt = ?, status = ?, updated_at = datetime('now') WHERE name = ? AND updated_at = ?",
        )
        .run(cadence, prompt, status, name, expected);
      if (result.changes === 0 || oldPrompt === undefined) {
        conflict = true;
        return;
      }
      logReplace(db, "routine", name, oldPrompt, prompt, "web");
    })();
    if (conflict) {
      errorPage(
        res,
        409,
        "Edit conflict",
        `<p>This routine changed since you opened it — most likely a coaching session updated it. Your edit was <strong>not</strong> saved.</p>
<p><a href="${base}/account/data/routines/edit?name=${encodeURIComponent(name)}">Reload the current version</a> and re-apply your change.</p>`,
      );
      return;
    }
  }
  redirect(res, `${base}/account/data/routines/edit?name=${encodeURIComponent(name)}&saved=1`);
}

function deleteRoutine(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const db = ctx.tenants.open(auth.userId);
  db.prepare("DELETE FROM routines WHERE name = ?").run(form.get("name") ?? "");
  redirect(res, `${ctx.cfg.publicUrl}/account/data/routines`);
}

// ---------------------------------------------------------------------------
// Change history (the `changes` table): read view + the two human-only
// mutations — restoring a deleted section/reference and purging history.
// Deletes are captured by the db.ts triggers; the save handlers above log
// overwrites via logReplace. Subtler recovery (re-grafting a lost passage
// into the current document) goes through a coaching session, which has the
// same history via the read-only list_changes/get_change tools.

const HISTORY_KINDS = ["section", "ref", "routine", "journal"];
const HISTORY_PAGE_LIMIT = 100;
const HISTORY_CLIP_CHARS = 4000;

function historyKind(value: string | null): ChangeKind | undefined {
  return value !== null && HISTORY_KINDS.includes(value) ? (value as ChangeKind) : undefined;
}

/** Bound the rendered size; the stored row stays complete. */
function clipText(text: string): string {
  return text.length > HISTORY_CLIP_CHARS
    ? `${text.slice(0, HISTORY_CLIP_CHARS)}\n… (${text.length} characters total)`
    : text;
}

/** Link target for a document's filtered history view. */
export function historyHref(base: string, kind: ChangeKind, name: string): string {
  return `${base}/account/data/history?kind=${kind}&amp;name=${encodeURIComponent(name)}`;
}

function renderHistory(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  lang: Lang,
): void {
  const base = ctx.cfg.publicUrl;
  const t = lang === "de" ? DATA_DE : DATA_EN;
  const db = ctx.tenants.open(auth.userId);
  const kind = historyKind(url.searchParams.get("kind"));
  const name = url.searchParams.get("name");
  const filtered = kind !== undefined && name !== null;
  const rows = (
    filtered
      ? db
          .prepare("SELECT * FROM changes WHERE kind = ? AND name = ? ORDER BY id DESC LIMIT ?")
          .all(kind, name, HISTORY_PAGE_LIMIT)
      : db.prepare("SELECT * FROM changes ORDER BY id DESC LIMIT ?").all(HISTORY_PAGE_LIMIT)
  ) as ChangeRow[];
  const csrf = htmlEscape(auth.csrf);

  const liveDoc = {
    section: db.prepare("SELECT 1 AS x FROM sections WHERE name = ?"),
    ref: db.prepare("SELECT 1 AS x FROM refs WHERE name = ?"),
  };

  const block = (label: string, text: string): string =>
    `<p class="muted">${label}</p><pre class="snippet">${htmlEscape(clipText(text))}</pre>`;

  const cards = rows
    .map((r) => {
      const restorable =
        r.op === "delete" &&
        (r.kind === "section" || r.kind === "ref") &&
        liveDoc[r.kind].get(r.name) === undefined;
      const restoreForm = restorable
        ? `<form method="post" action="${base}/account/data/history/restore">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${r.id}">
<button>${t.historyRestore}</button></form>`
        : "";
      const content =
        r.op === "edit"
          ? block(t.historyRemoved, r.old_text) + block(t.historyInserted, r.new_text ?? "")
          : r.op === "replace"
            ? block(t.historyDiff, r.old_text)
            : block(t.historyDeleted, r.old_text);
      return `<div class="card"><p>#${r.id} · <strong>${r.op}</strong> · ${htmlEscape(r.kind)} <code>${htmlEscape(r.name)}</code> <span class="muted">· ${htmlEscape(r.created_at)} UTC${r.source ? ` · ${htmlEscape(r.source)}` : ""}</span></p>
${content}${restoreForm}</div>`;
    })
    .join("\n");

  const filterBar = filtered
    ? `<p class="muted">${fill(t.historyFiltered, { KIND: htmlEscape(kind), NAME: htmlEscape(name) })} — <a href="${base}/account/data/history">${t.historyShowAll}</a></p>`
    : "";
  const purgeForm =
    rows.length > 0
      ? `<form method="post" action="${base}/account/data/history/purge">
<input type="hidden" name="csrf" value="${csrf}">${filtered ? `<input type="hidden" name="kind" value="${htmlEscape(kind)}"><input type="hidden" name="name" value="${htmlEscape(name)}">` : ""}
<button class="danger">${filtered ? t.historyPurgeDoc : t.historyPurgeAll}</button></form>`
      : "";

  const body = `<h1>${t.historyTitle}</h1>
${url.searchParams.get("restored") === "1" ? `<p class="muted">${t.historyRestored}</p>` : ""}
<p class="muted">${t.historyIntro}</p>
${filterBar}
${cards || `<p class="muted">${t.historyEmpty}</p>`}
${purgeForm}
<p class="muted">${t.historyPurgeNote}</p>`;

  const path = filtered
    ? `/account/data/history?kind=${kind}&name=${encodeURIComponent(name)}`
    : "/account/data/history";
  sendHtml(
    res,
    200,
    page(t.historyTitle, dataShell(base, "history", t, body), {
      wide: true,
      nav: dataNav(base, lang, path),
    }),
  );
}

/**
 * Recreate a deleted section/reference from its delete-history row. Only
 * possible while no document of that name exists — the INSERT is a plain
 * create (deliberately not history-logged; the original delete row remains
 * the record). Deleted routines/journal entries are restored in a coaching
 * session instead, where cadence/status can be re-confirmed with judgment.
 */
function restoreDeletedDoc(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const base = ctx.cfg.publicUrl;
  const id = Number(form.get("id"));
  const db = ctx.tenants.open(auth.userId);
  const row = db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as ChangeRow | undefined;
  if (!row || row.op !== "delete" || (row.kind !== "section" && row.kind !== "ref")) {
    errorPage(
      res,
      400,
      "Invalid request",
      "<p>This history entry cannot be restored directly — recover its content in a coaching session instead.</p>",
    );
    return;
  }
  if (
    refuseOversizedWrite(ctx, res, auth, db, {
      docBytes: row.old_text.length,
      docMax: DOC_MAX_BYTES,
      deltaBytes: row.old_text.length,
    })
  ) {
    return;
  }
  const table = row.kind === "section" ? "sections" : "refs";
  try {
    db.prepare(`INSERT INTO ${table} (name, content) VALUES (?, ?)`).run(row.name, row.old_text);
  } catch {
    errorPage(
      res,
      409,
      "Already exists",
      `<p>A ${row.kind === "section" ? "section" : "reference"} named <code>${htmlEscape(row.name)}</code> already exists — nothing was restored. Merge the recorded content in a coaching session instead.</p>`,
    );
    return;
  }
  redirect(res, `${base}/account/data/history?restored=1`);
}

/**
 * The one mutation on history, deliberately web-only (never over MCP):
 * deliberately deleted content must not linger against the user's will.
 */
function purgeHistory(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  form: URLSearchParams,
): void {
  const db = ctx.tenants.open(auth.userId);
  const kind = historyKind(form.get("kind"));
  const name = form.get("name");
  if (kind !== undefined && name !== null) {
    db.prepare("DELETE FROM changes WHERE kind = ? AND name = ?").run(kind, name);
  } else {
    db.prepare("DELETE FROM changes").run();
  }
  redirect(res, `${ctx.cfg.publicUrl}/account/data/history`);
}

// ---------------------------------------------------------------------------
// UI strings. EN values are the exact pre-i18n strings (tests assert on them);
// %UPPERCASE% slots are filled via fill(). Status <option> labels deliberately
// stay the raw status words in both languages — the submitted values must not
// change. Error pages (errorPage/backBar above) deliberately stay English.

const DATA_EN = {
  navOverview: "Overview",
  navSections: "Sections",
  navReferences: "References",
  navJournal: "Journal",
  navOpenItems: "Open items",
  navRoutines: "Routines",
  title: "Your data",
  sectionsTitle: "Knowledge sections",
  sectionsHint: "<code>main</code> is your SKILL.md — the primary coaching context.",
  refsTitle: "Reference documents",
  thName: "Name",
  thUpdated: "Updated (UTC)",
  thSize: "Size",
  none: "none",
  newSection: "New section",
  newReference: "New reference",
  journalTitle: "Journal",
  journalCount: "%N% entries",
  browseEdit: "browse &amp; edit",
  openItemsTitle: "Open items",
  openSummary: "%OPEN% open of %TOTAL% total",
  manage: "manage",
  routinesTitle: "Routines",
  routinesStored: "%N% stored",
  viewCopy: "view &amp; copy",
  routinesHint:
    "Check-in prompts designed with your coach; copy them into scheduled tasks in your Claude account.",
  typeSection: "section",
  typeReference: "reference",
  savedNotice: "✓ Saved.",
  lastUpdated: "Last updated %TS% UTC",
  docNamePlaceholder: "name (e.g. race-plan)",
  deleteDoc: "Delete this %TYPE%",
  mainProtected: "The <code>main</code> section cannot be deleted — it is the canonical SKILL.md.",
  previewHint: "Rendered preview — updates when you save",
  save: "Save",
  journalIntro:
    "%TOTAL% entries, newest first. Entries are written by your coaching sessions; you can correct or remove them here.",
  edit: "edit",
  noEntries: "No entries yet.",
  newer: "← newer",
  older: "older →",
  journalEntryTitle: "Journal entry #%ID%",
  journalWritten: "Written %TS% UTC (timestamp is preserved on edit)",
  deleteEntry: "Delete entry",
  openItemsIntro: "Commitments and flags from your coaching sessions (open first).",
  openItemTitle: "Open item #%ID%",
  created: "Created %TS% UTC",
  statusLabel: "Status:",
  relevantDate: "Relevant date (optional):",
  datePlaceholder: "YYYY-MM-DD",
  deleteItem: "Delete item",
  routinesIntro:
    "Check-in prompts designed with your coach. To run one, copy its prompt into a scheduled task in your own Claude account with the cadence shown — the server never starts conversations itself. The routine stored here is the master; the scheduled task runs your last pasted copy, so re-copy the prompt after every edit.",
  open: "open",
  noRoutines:
    "No routines yet — ask your coach for a check-in routine and it will design one with you.",
  newRoutine: "New routine",
  routineWord: "routine",
  routineSaved:
    "✓ Saved. To apply the change, update the matching scheduled task in your Claude account.",
  routineMeta: "Last updated %TS% UTC · status <strong>%STATUS%</strong> · cadence %CADENCE%",
  routineCopyHint:
    "Select the prompt below and copy it into a Claude scheduled task with this cadence.",
  routineNamePlaceholder: "name (e.g. weekly-review)",
  cadenceLabel: "Cadence:",
  cadencePlaceholder: "e.g. weekly, Sunday ~19:00",
  statusHint: "active = scheduled in Claude; paused/retired = not.",
  deleteRoutine: "Delete this routine",
  navHistory: "History",
  historyTitle: "Change history",
  historyIntro:
    "What recent edits, overwrites, and deletions removed from your documents — kept for a limited time as a safety net, so content lost by mistake can be recovered. It never counts against your storage quota. Deleted sections and references can be restored directly below; for anything subtler, ask your coaching session to recover it (it sees the same history).",
  historyFiltered: "Showing changes to %KIND% <code>%NAME%</code>",
  historyShowAll: "show all",
  historyEmpty: "No recorded changes yet.",
  historyRemoved: "Removed text",
  historyInserted: "Inserted text",
  historyDiff: "Diff of the previous version — lines starting with '-' were removed",
  historyDeleted: "Deleted content",
  historyRestore: "Restore this document",
  historyRestored: "✓ Restored.",
  historyPurgeAll: "Delete all history",
  historyPurgeDoc: "Delete this document's history",
  historyPurgeNote:
    "History is pruned automatically after its retention window. Deleting it here is immediate and permanent — recorded content is gone for good.",
  historyLink: "change history",
};

const DATA_DE: typeof DATA_EN = {
  navOverview: "Übersicht",
  navSections: "Sektionen",
  navReferences: "Referenzen",
  navJournal: "Journal",
  navOpenItems: "Offene Punkte",
  navRoutines: "Routinen",
  title: "Deine Daten",
  sectionsTitle: "Wissens-Sektionen",
  sectionsHint: "<code>main</code> ist deine SKILL.md — der primäre Coaching-Kontext.",
  refsTitle: "Referenzdokumente",
  thName: "Name",
  thUpdated: "Aktualisiert (UTC)",
  thSize: "Größe",
  none: "keine",
  newSection: "Neue Sektion",
  newReference: "Neue Referenz",
  journalTitle: "Journal",
  journalCount: "%N% Einträge",
  browseEdit: "durchsuchen &amp; bearbeiten",
  openItemsTitle: "Offene Punkte",
  openSummary: "%OPEN% offen von %TOTAL% insgesamt",
  manage: "verwalten",
  routinesTitle: "Routinen",
  routinesStored: "%N% gespeichert",
  viewCopy: "ansehen &amp; kopieren",
  routinesHint:
    "Check-in-Prompts, mit deinem Coach entworfen; kopiere sie in geplante Aufgaben in deinem Claude-Konto.",
  typeSection: "Sektion",
  typeReference: "Referenz",
  savedNotice: "✓ Gespeichert.",
  lastUpdated: "Zuletzt aktualisiert %TS% UTC",
  docNamePlaceholder: "Name (z. B. race-plan)",
  deleteDoc: "Diese %TYPE% löschen",
  mainProtected:
    "Die <code>main</code>-Sektion kann nicht gelöscht werden — sie ist die kanonische SKILL.md.",
  previewHint: "Gerenderte Vorschau — aktualisiert sich beim Speichern",
  save: "Speichern",
  journalIntro:
    "%TOTAL% Einträge, neueste zuerst. Einträge werden von deinen Coaching-Sessions geschrieben; hier kannst du sie korrigieren oder entfernen.",
  edit: "bearbeiten",
  noEntries: "Noch keine Einträge.",
  newer: "← neuere",
  older: "ältere →",
  journalEntryTitle: "Journaleintrag #%ID%",
  journalWritten: "Geschrieben %TS% UTC (der Zeitstempel bleibt beim Bearbeiten erhalten)",
  deleteEntry: "Eintrag löschen",
  openItemsIntro: "Zusagen und Hinweise aus deinen Coaching-Sessions (offene zuerst).",
  openItemTitle: "Offener Punkt #%ID%",
  created: "Erstellt %TS% UTC",
  statusLabel: "Status:",
  relevantDate: "Relevantes Datum (optional):",
  datePlaceholder: "YYYY-MM-DD",
  deleteItem: "Punkt löschen",
  routinesIntro:
    "Check-in-Prompts, die du mit deinem Coach entworfen hast. Zum Ausführen kopiere den Prompt in eine geplante Aufgabe in deinem eigenen Claude-Konto mit dem angegebenen Rhythmus — der Server startet nie selbst Unterhaltungen. Die hier gespeicherte Routine ist das Original; die geplante Aufgabe führt deine zuletzt eingefügte Kopie aus — nach jeder Änderung den Prompt also erneut kopieren.",
  open: "öffnen",
  noRoutines:
    "Noch keine Routinen — bitte deinen Coach um eine Check-in-Routine, dann entwirft er sie mit dir.",
  newRoutine: "Neue Routine",
  routineWord: "Routine",
  routineSaved:
    "✓ Gespeichert. Damit die Änderung wirkt, aktualisiere die passende geplante Aufgabe in deinem Claude-Konto.",
  routineMeta:
    "Zuletzt aktualisiert %TS% UTC · Status <strong>%STATUS%</strong> · Rhythmus %CADENCE%",
  routineCopyHint:
    "Markiere den Prompt unten und kopiere ihn in eine geplante Claude-Aufgabe mit diesem Rhythmus.",
  routineNamePlaceholder: "Name (z. B. weekly-review)",
  cadenceLabel: "Rhythmus:",
  cadencePlaceholder: "z. B. wöchentlich, Sonntag ~19:00",
  statusHint: "active = in Claude geplant; paused/retired = nicht.",
  deleteRoutine: "Diese Routine löschen",
  navHistory: "Verlauf",
  historyTitle: "Änderungsverlauf",
  historyIntro:
    "Was kürzliche Bearbeitungen, Überschreibungen und Löschungen aus deinen Dokumenten entfernt haben — als Sicherheitsnetz für begrenzte Zeit aufbewahrt, damit versehentlich verlorene Inhalte wiederhergestellt werden können. Er zählt nie gegen dein Speicherkontingent. Gelöschte Sektionen und Referenzen kannst du direkt unten wiederherstellen; für alles Feinere bitte deine Coaching-Session um Wiederherstellung (sie sieht denselben Verlauf).",
  historyFiltered: "Zeige Änderungen an %KIND% <code>%NAME%</code>",
  historyShowAll: "alle anzeigen",
  historyEmpty: "Noch keine aufgezeichneten Änderungen.",
  historyRemoved: "Entfernter Text",
  historyInserted: "Eingefügter Text",
  historyDiff: "Diff der vorherigen Version — Zeilen mit '-' wurden entfernt",
  historyDeleted: "Gelöschter Inhalt",
  historyRestore: "Dieses Dokument wiederherstellen",
  historyRestored: "✓ Wiederhergestellt.",
  historyPurgeAll: "Gesamten Verlauf löschen",
  historyPurgeDoc: "Verlauf dieses Dokuments löschen",
  historyPurgeNote:
    "Der Verlauf wird nach seiner Aufbewahrungsfrist automatisch bereinigt. Das Löschen hier wirkt sofort und endgültig — aufgezeichnete Inhalte sind dann unwiederbringlich weg.",
  historyLink: "Änderungsverlauf",
};
