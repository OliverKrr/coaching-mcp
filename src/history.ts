import type Database from "better-sqlite3";

/**
 * Change history: a per-user delta log of what write operations REMOVED from
 * stored documents, so content lost by mistake (an agent overwriting or
 * deleting the wrong thing) can be found and re-applied. Deliberately not a
 * versioned document store — recovery is re-grafting lost content into the
 * *current* document via the normal write tools, never a mechanical revert.
 *
 * Capture happens at two levels:
 * - Deletes: `*_hist_ad` AFTER DELETE triggers in db.ts (cannot be bypassed
 *   by any code path). A deletion's delta is the whole document, so those
 *   rows hold the full old content.
 * - Edits/overwrites: every overwrite path calls `logEdit`/`logReplace` in
 *   the same transaction as the write (SQL can't compute text diffs, so this
 *   layer is convention-enforced — see CLAUDE.md).
 *
 * History is a safety net, not stored content: rows are excluded from the
 * `content_bytes` quota counter and bounded by `pruneChanges` on every DB
 * open instead. The MCP surface over this table is read-only; purging is a
 * human-only action on the account page.
 */

export type ChangeKind = "section" | "ref" | "routine" | "journal";
export type ChangeOp = "edit" | "replace" | "delete";
export type ChangeSource = "mcp" | "web" | "restore-cli";

export type ChangeRow = {
  id: number;
  kind: ChangeKind;
  name: string;
  op: ChangeOp;
  old_text: string;
  new_text: string | null;
  source: ChangeSource | null;
  created_at: string;
};

/** Retention defaults; env-overridable (read per call so tests can vary them). */
const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_MAX_PER_DOC = 40;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Table + index only (no triggers) — also applied standalone by the restore
 * CLI, which operates on live DBs that may predate this feature. The
 * delete-capture triggers live with the other trigger families in db.ts.
 */
export const CHANGES_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS changes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL CHECK (kind IN ('section','ref','routine','journal')),
		name TEXT NOT NULL,
		op TEXT NOT NULL CHECK (op IN ('edit','replace','delete')),
		old_text TEXT NOT NULL,
		new_text TEXT,
		source TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS changes_doc ON changes(kind, name, id);
`;

export function ensureChangesSchema(db: Database.Database): void {
  db.exec(CHANGES_TABLE_SQL);
}

const INSERT_SQL =
  "INSERT INTO changes(kind, name, op, old_text, new_text, source) VALUES (?, ?, ?, ?, ?, ?)";

/** Record an exact-string edit (edit_section / edit_reference). */
export function logEdit(
  db: Database.Database,
  kind: ChangeKind,
  name: string,
  oldString: string,
  newString: string,
  source: ChangeSource,
): void {
  db.prepare(INSERT_SQL).run(kind, name, "edit", oldString, newString, source);
}

/**
 * Record a full-document overwrite as a compact line diff of the previous
 * version. No-op when the content is unchanged.
 */
export function logReplace(
  db: Database.Database,
  kind: ChangeKind,
  name: string,
  oldContent: string,
  newContent: string,
  source: ChangeSource,
): void {
  if (oldContent === newContent) return;
  db.prepare(INSERT_SQL).run(
    kind,
    name,
    "replace",
    blockDiff(oldContent, newContent),
    null,
    source,
  );
}

/**
 * Minimal line diff: trim common prefix/suffix lines, emit the remaining
 * middle as one removed/added block. No LCS, no dependency — for recovery the
 * removed lines are what matters, and a rewrite that changes everything
 * correctly yields a delta the size of the old document.
 */
export function blockDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const header =
    removed.length === 0
      ? `@@ inserted after line ${start} (previous version had ${a.length} lines) @@`
      : `@@ lines ${start + 1}-${endA} of ${a.length} (previous version) @@`;
  return [header, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Total stored history size (for get_version / pruning). */
export function historyBytes(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(old_text) + LENGTH(COALESCE(new_text, ''))), 0) AS n FROM changes",
      )
      .get() as { n: number }
  ).n;
}

/**
 * Retention: age cap, per-document version cap, global byte backstop —
 * applied on every DB open (the recomputeContentBytes pattern), so bounds
 * self-apply without a scheduler. The per-doc cap also defuses
 * delete/recreate loops inflating history with full copies.
 */
export function pruneChanges(db: Database.Database): void {
  const maxAgeDays = envInt("HISTORY_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS);
  const maxPerDoc = envInt("HISTORY_MAX_PER_DOC", DEFAULT_MAX_PER_DOC);
  const maxBytes = envInt("HISTORY_MAX_BYTES", DEFAULT_MAX_BYTES);

  db.prepare("DELETE FROM changes WHERE created_at < datetime('now', ?)").run(
    `-${maxAgeDays} days`,
  );
  db.prepare(
    `DELETE FROM changes WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY kind, name ORDER BY id DESC) AS rn
				FROM changes
			) WHERE rn > ?
		)`,
  ).run(maxPerDoc);

  let total = historyBytes(db);
  if (total <= maxBytes) return;
  const rows = db
    .prepare(
      "SELECT id, LENGTH(old_text) + LENGTH(COALESCE(new_text, '')) AS sz FROM changes ORDER BY id",
    )
    .all() as Array<{ id: number; sz: number }>;
  const del = db.prepare("DELETE FROM changes WHERE id = ?");
  for (const row of rows) {
    if (total <= maxBytes) break;
    del.run(row.id);
    total -= row.sz;
  }
}
