import type { ServerResponse } from "node:http";
import type { WebAuth } from "./account.js";
import type { ServeContext } from "./context.js";
import { htmlEscape, page, redirect, sendHtml } from "./http-util.js";
import { renderMarkdown } from "./markdown.js";

/**
 * Browse & edit area under /account/data: every document the server stores
 * about the signed-in user — sections, references, journal entries, open
 * items — viewable and editable in the browser, without a coaching session.
 *
 * Server-rendered like the rest of the account surface. Content is shown in
 * textareas/<pre> (it is markdown authored for an LLM — no HTML rendering, no
 * XSS surface). Section/reference saves carry the row's `updated_at` as an
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

function backBar(base: string, label = "Your data", href = "/account/data"): string {
  return `<p class="muted"><a href="${base}/account">Account</a> › <a href="${base}${href}">${htmlEscape(label)}</a></p>`;
}

function errorPage(res: ServerResponse, status: number, title: string, body: string): void {
  sendHtml(res, status, page(title, `<h1>${htmlEscape(title)}</h1>${body}`));
}

// ---------------------------------------------------------------------------
// GET routes

export function handleDataGet(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
): boolean {
  const path = url.pathname;
  switch (path) {
    case "/account/data":
      renderOverview(ctx, res, auth);
      return true;
    case "/account/data/doc":
      renderDocEditor(ctx, res, auth, url);
      return true;
    case "/account/data/new":
      renderDocEditor(ctx, res, auth, url, { isNew: true });
      return true;
    case "/account/data/journal":
      renderJournal(ctx, res, auth, url);
      return true;
    case "/account/data/journal/edit":
      renderJournalEditor(ctx, res, auth, url);
      return true;
    case "/account/data/open-items":
      renderOpenItems(ctx, res, auth);
      return true;
    case "/account/data/open-items/edit":
      renderOpenItemEditor(ctx, res, auth, url);
      return true;
    default:
      return false;
  }
}

function renderOverview(ctx: ServeContext, res: ServerResponse, auth: WebAuth): void {
  const base = ctx.cfg.publicUrl;
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
    return `<table><tr><th>Name</th><th>Updated (UTC)</th><th>Size</th></tr>${body || '<tr><td colspan="3" class="muted">none</td></tr>'}</table>
<p><a href="${base}/account/data/new?type=${type}"><button>New ${type}</button></a></p>`;
  };

  const journalCount = (db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n;
  const openCount = (
    db.prepare("SELECT COUNT(*) AS n FROM open_items WHERE status = 'open'").get() as {
      n: number;
    }
  ).n;
  const itemCount = (db.prepare("SELECT COUNT(*) AS n FROM open_items").get() as { n: number }).n;

  sendHtml(
    res,
    200,
    page(
      "Your data",
      `${backBar(base)}
<h1>Your data</h1>
<div class="card"><h2>Knowledge sections</h2><p class="muted"><code>main</code> is your SKILL.md — the primary coaching context.</p>${docTable("section")}</div>
<div class="card"><h2>Reference documents</h2>${docTable("reference")}</div>
<div class="card"><h2>Journal</h2><p>${journalCount} entries — <a href="${base}/account/data/journal">browse &amp; edit</a></p></div>
<div class="card"><h2>Open items</h2><p>${openCount} open of ${itemCount} total — <a href="${base}/account/data/open-items">manage</a></p></div>`,
    ),
  );
}

function renderDocEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
  { isNew = false }: { isNew?: boolean } = {},
): void {
  const base = ctx.cfg.publicUrl;
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
  const nameField = row
    ? `<input type="hidden" name="name" value="${htmlEscape(row.name)}"><code>${htmlEscape(row.name)}</code>`
    : `<input type="text" name="name" placeholder="name (e.g. race-plan)" required>`;
  const deleteForm =
    row && !protectedMain
      ? `<form method="post" action="${base}/account/data/doc/delete" onsubmit="return confirm('Delete ${htmlEscape(row.name)}? This cannot be undone.')">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="type" value="${type}"><input type="hidden" name="name" value="${htmlEscape(row.name)}">
<button class="danger">Delete this ${type}</button></form>`
      : protectedMain
        ? `<p class="muted">The <code>main</code> section cannot be deleted — it is the canonical SKILL.md.</p>`
        : "";

  const previewColumn = row
    ? `<div>
<p class="muted">Rendered preview — updates when you save</p>
<div class="preview">${renderMarkdown(row.content)}</div>
</div>`
    : "";

  sendHtml(
    res,
    200,
    page(
      row ? `${type}: ${row.name}` : `New ${type}`,
      `${backBar(base)}
<h1>${row ? `${htmlEscape(type)}: ${htmlEscape(row.name)}` : `New ${htmlEscape(type)}`}</h1>
${saved ? '<p class="muted">✓ Saved.</p>' : ""}
${row ? `<p class="muted">Last updated ${htmlEscape(row.updated_at)} UTC</p>` : ""}
<div class="split">
<div>
<form method="post" action="${base}/account/data/doc/save">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="type" value="${type}">
<input type="hidden" name="expected_updated_at" value="${htmlEscape(row?.updated_at ?? "")}">
<p>${nameField}</p>
<textarea name="content" class="editor">${htmlEscape(row?.content ?? "")}</textarea>
<p><button>Save</button></p>
</form>
${deleteForm}
</div>
${previewColumn}
</div>`,
      { wide: true },
    ),
  );
}

function renderJournal(ctx: ServeContext, res: ServerResponse, auth: WebAuth, url: URL): void {
  const base = ctx.cfg.publicUrl;
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
        `<div class="card"><p class="muted">${htmlEscape(r.created_at)} UTC — <a href="${base}/account/data/journal/edit?id=${r.id}">edit</a></p>
<pre style="white-space:pre-wrap;margin:0">${htmlEscape(r.entry)}</pre></div>`,
    )
    .join("\n");
  const nav = [
    pageNo > 0 ? `<a href="${base}/account/data/journal?page=${pageNo - 1}">← newer</a>` : "",
    (pageNo + 1) * JOURNAL_PAGE_SIZE < total
      ? `<a href="${base}/account/data/journal?page=${pageNo + 1}">older →</a>`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  sendHtml(
    res,
    200,
    page(
      "Journal",
      `${backBar(base)}
<h1>Journal</h1>
<p class="muted">${total} entries, newest first. Entries are written by your coaching sessions; you can correct or remove them here.</p>
${entries || '<p class="muted">No entries yet.</p>'}
<p>${nav}</p>`,
    ),
  );
}

function renderJournalEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
): void {
  const base = ctx.cfg.publicUrl;
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
  sendHtml(
    res,
    200,
    page(
      `Journal entry #${row.id}`,
      `${backBar(base, "Journal", "/account/data/journal")}
<h1>Journal entry #${row.id}</h1>
<p class="muted">Written ${htmlEscape(row.created_at)} UTC (timestamp is preserved on edit)</p>
<form method="post" action="${base}/account/data/journal/save">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<textarea name="entry" rows="12" style="width:100%;font-family:ui-monospace,monospace;font-size:.9rem">${htmlEscape(row.entry)}</textarea>
<p><button>Save</button></p>
</form>
<form method="post" action="${base}/account/data/journal/delete" onsubmit="return confirm('Delete this journal entry? This cannot be undone.')">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<button class="danger">Delete entry</button></form>`,
    ),
  );
}

function renderOpenItems(ctx: ServeContext, res: ServerResponse, auth: WebAuth): void {
  const base = ctx.cfg.publicUrl;
  const db = ctx.tenants.open(auth.userId);
  const rows = db
    .prepare(
      "SELECT id, kind, content, status, relevant_date, created_at FROM open_items ORDER BY (status != 'open'), id DESC",
    )
    .all() as ItemRow[];
  const body = rows
    .map((r) => {
      const preview = r.content.length > 80 ? `${r.content.slice(0, 80)}…` : r.content;
      return `<tr><td>#${r.id}</td><td>${htmlEscape(r.kind)}</td><td>${htmlEscape(r.status)}</td><td>${htmlEscape(r.relevant_date ?? "—")}</td><td>${htmlEscape(preview)}</td><td><a href="${base}/account/data/open-items/edit?id=${r.id}">edit</a></td></tr>`;
    })
    .join("\n");
  sendHtml(
    res,
    200,
    page(
      "Open items",
      `${backBar(base)}
<h1>Open items</h1>
<p class="muted">Commitments and flags from your coaching sessions (open first).</p>
<div style="overflow-x:auto"><table><tr><th>#</th><th>Kind</th><th>Status</th><th>Date</th><th>Content</th><th></th></tr>${body || '<tr><td colspan="6" class="muted">none</td></tr>'}</table></div>`,
    ),
  );
}

function renderOpenItemEditor(
  ctx: ServeContext,
  res: ServerResponse,
  auth: WebAuth,
  url: URL,
): void {
  const base = ctx.cfg.publicUrl;
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
  sendHtml(
    res,
    200,
    page(
      `Open item #${row.id}`,
      `${backBar(base, "Open items", "/account/data/open-items")}
<h1>Open item #${row.id} <span class="muted">[${htmlEscape(row.kind)}]</span></h1>
<p class="muted">Created ${htmlEscape(row.created_at)} UTC</p>
<form method="post" action="${base}/account/data/open-items/save">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<textarea name="content" rows="6" style="width:100%;font-family:ui-monospace,monospace;font-size:.9rem">${htmlEscape(row.content)}</textarea>
<p><label>Status:
<select name="status">${statusOption("open")}${statusOption("done")}${statusOption("dismissed")}</select></label></p>
<p><label>Relevant date (optional): <input type="text" name="relevant_date" value="${htmlEscape(row.relevant_date ?? "")}" placeholder="YYYY-MM-DD"></label></p>
<p><button>Save</button></p>
</form>
<form method="post" action="${base}/account/data/open-items/delete" onsubmit="return confirm('Delete open item #${row.id}? This cannot be undone.')">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${row.id}">
<button class="danger">Delete item</button></form>`,
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
    const result = db
      .prepare(
        `UPDATE ${table} SET content = ?, updated_at = datetime('now') WHERE name = ? AND updated_at = ?`,
      )
      .run(content, name, expected);
    if (result.changes === 0) {
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
  // created_at is intentionally preserved: the edit corrects content, not history
  const result = db.prepare("UPDATE journal SET entry = ? WHERE id = ?").run(entry, id);
  if (result.changes === 0) {
    errorPage(res, 404, "Not found", `<p>No journal entry #${htmlEscape(String(id))}.</p>`);
    return;
  }
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
