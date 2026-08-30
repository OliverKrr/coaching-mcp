import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGES_TABLE_SQL, migrateChangesKindCheck, pruneChanges } from "./history.js";
import { latestUpdateId, loadSeedUpdates, setAppliedUpdateId } from "./seed-updates.js";

export type Section = { name: string; content: string; updated_at: string };
export type Reference = { name: string; content: string; updated_at: string };
export type JournalEntry = {
  id: number;
  entry: string;
  /** Correction attached by a later session; NULL = the entry stands as written. */
  correction: string | null;
  corrected_at: string | null;
  /** Set once a period has been condensed elsewhere; NULL = still inlined in full. */
  archived_at: string | null;
  created_at: string;
};
export type OpenItem = {
  id: number;
  kind: "commitment" | "flag";
  content: string;
  status: "open" | "done" | "dismissed";
  source: string | null;
  dedup_key: string | null;
  relevant_date: string | null;
  resolved_note: string | null;
  created_at: string;
  updated_at: string;
};
export type Routine = {
  name: string;
  cadence: string;
  prompt: string;
  status: "active" | "paused" | "retired";
  created_at: string;
  updated_at: string;
};
export type Metric = {
  id: number;
  name: string;
  value: number;
  unit: string | null;
  note: string | null;
  measured_at: string;
  created_at: string;
  /** For 'state' series: when a newer value superseded this one; NULL = currently valid. */
  valid_to: string | null;
};
export type MetricSeries = {
  name: string;
  /** 'state' = a new value supersedes the previous one; 'event' = values accumulate. */
  kind: "state" | "event";
  /** Days after which the current 'state' value is flagged stale; NULL = never. */
  stale_after_days: number | null;
  created_at: string;
};
export const ROUTINE_STATUSES = ["active", "paused", "retired"] as const;

const DEFAULT_DATA_DIR = "/data";
const DEFAULT_SEED_DIR = "/seed";

export function openDatabase(
  dataDir: string = process.env.DATA_DIR ?? DEFAULT_DATA_DIR,
  seedDir: string = process.env.SEED_DIR ?? DEFAULT_SEED_DIR,
): Database.Database {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "skill.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  createSchema(db);
  seedFromDirectory(db, seedDir);
  recomputeContentBytes(db);
  pruneChanges(db);
  return db;
}

/**
 * Quota metric: total stored content characters (SQLite LENGTH semantics)
 * across every user-authored table. The `*_bytes_*` triggers keep the counter
 * in the same transaction as each write; this full recompute on every open
 * self-heals any drift and initializes pre-counter databases.
 * The `changes` history table is deliberately NOT counted — the safety net
 * must not eat the quota it protects; it is bounded by pruneChanges instead.
 */
export function recomputeContentBytes(db: Database.Database): void {
  const n = (
    db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM sections)
				+ (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM refs)
				+ (SELECT COALESCE(SUM(LENGTH(entry) + LENGTH(COALESCE(correction, ''))), 0) FROM journal)
				+ (SELECT COALESCE(SUM(LENGTH(prompt)), 0) FROM routines)
				+ (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM open_items)
				+ (SELECT COALESCE(SUM(LENGTH(name) + LENGTH(COALESCE(unit, '')) + LENGTH(COALESCE(note, ''))), 0) FROM metrics) AS n`,
      )
      .get() as { n: number }
  ).n;
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('content_bytes', ?)" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(n);
}

/**
 * The journal's FTS index, quota counters and delete-capture trigger — one
 * string because `migrateJournalIndex` has to drop and recreate the whole
 * family: FTS5 cannot gain a column and a trigger body cannot be altered, so
 * `CREATE ... IF NOT EXISTS` alone would leave a database that predates
 * corrections indexing (and counting) only `entry`.
 */
const JOURNAL_INDEX_SQL = `
		CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
			entry, correction,
			content=journal, content_rowid=id
		);
		CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal BEGIN
			INSERT INTO journal_fts(rowid, entry, correction)
				VALUES (new.id, new.entry, new.correction);
		END;
		CREATE TRIGGER IF NOT EXISTS journal_au AFTER UPDATE ON journal BEGIN
			INSERT INTO journal_fts(journal_fts, rowid, entry, correction)
				VALUES ('delete', old.id, old.entry, old.correction);
			INSERT INTO journal_fts(rowid, entry, correction)
				VALUES (new.id, new.entry, new.correction);
		END;
		CREATE TRIGGER IF NOT EXISTS journal_ad AFTER DELETE ON journal BEGIN
			INSERT INTO journal_fts(journal_fts, rowid, entry, correction)
				VALUES ('delete', old.id, old.entry, old.correction);
		END;
		CREATE TRIGGER IF NOT EXISTS journal_bytes_ai AFTER INSERT ON journal BEGIN
			UPDATE meta SET value = value + LENGTH(new.entry) + LENGTH(COALESCE(new.correction, ''))
				WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS journal_bytes_au AFTER UPDATE ON journal BEGIN
			UPDATE meta SET value = value + LENGTH(new.entry) + LENGTH(COALESCE(new.correction, ''))
				- LENGTH(old.entry) - LENGTH(COALESCE(old.correction, '')) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS journal_bytes_ad AFTER DELETE ON journal BEGIN
			UPDATE meta SET value = value - LENGTH(old.entry) - LENGTH(COALESCE(old.correction, ''))
				WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS journal_hist_ad AFTER DELETE ON journal BEGIN
			INSERT INTO changes(kind, name, op, old_text)
				VALUES ('journal', CAST(old.id AS TEXT), 'delete',
					old.entry || COALESCE(char(10) || char(10) || 'Correction: ' || old.correction, ''));
		END;
`;

export function createSchema(db: Database.Database): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS sections (
			name TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS refs (
			name TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS journal (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entry TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			correction TEXT,
			corrected_at TEXT,
			archived_at TEXT
		);
		CREATE TABLE IF NOT EXISTS open_items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL CHECK (kind IN ('commitment','flag')),
			content TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
			source TEXT,
			dedup_key TEXT,
			relevant_date TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS open_items_kind_status ON open_items(kind, status);
		CREATE TABLE IF NOT EXISTS routines (
			name TEXT PRIMARY KEY,
			cadence TEXT NOT NULL,
			prompt TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			value REAL NOT NULL,
			unit TEXT,
			note TEXT,
			measured_at TEXT NOT NULL DEFAULT (datetime('now')),
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS metrics_name_measured ON metrics(name, measured_at);
		CREATE TABLE IF NOT EXISTS metric_series (
			name TEXT PRIMARY KEY,
			kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('state','event')),
			stale_after_days INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
			name UNINDEXED, content,
			content=sections, content_rowid=rowid
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS refs_fts USING fts5(
			name UNINDEXED, content,
			content=refs, content_rowid=rowid
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS routines_fts USING fts5(
			name UNINDEXED, prompt,
			content=routines, content_rowid=rowid
		);
		CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
			INSERT INTO sections_fts(rowid, name, content) VALUES (new.rowid, new.name, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS sections_au AFTER UPDATE ON sections BEGIN
			INSERT INTO sections_fts(sections_fts, rowid, name, content)
				VALUES ('delete', old.rowid, old.name, old.content);
			INSERT INTO sections_fts(rowid, name, content) VALUES (new.rowid, new.name, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS refs_ai AFTER INSERT ON refs BEGIN
			INSERT INTO refs_fts(rowid, name, content) VALUES (new.rowid, new.name, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS refs_au AFTER UPDATE ON refs BEGIN
			INSERT INTO refs_fts(refs_fts, rowid, name, content)
				VALUES ('delete', old.rowid, old.name, old.content);
			INSERT INTO refs_fts(rowid, name, content) VALUES (new.rowid, new.name, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
			INSERT INTO sections_fts(sections_fts, rowid, name, content)
				VALUES ('delete', old.rowid, old.name, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS refs_ad AFTER DELETE ON refs BEGIN
			INSERT INTO refs_fts(refs_fts, rowid, name, content)
				VALUES ('delete', old.rowid, old.name, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS routines_ai AFTER INSERT ON routines BEGIN
			INSERT INTO routines_fts(rowid, name, prompt) VALUES (new.rowid, new.name, new.prompt);
		END;
		CREATE TRIGGER IF NOT EXISTS routines_au AFTER UPDATE ON routines BEGIN
			INSERT INTO routines_fts(routines_fts, rowid, name, prompt)
				VALUES ('delete', old.rowid, old.name, old.prompt);
			INSERT INTO routines_fts(rowid, name, prompt) VALUES (new.rowid, new.name, new.prompt);
		END;
		CREATE TRIGGER IF NOT EXISTS routines_ad AFTER DELETE ON routines BEGIN
			INSERT INTO routines_fts(routines_fts, rowid, name, prompt)
				VALUES ('delete', old.rowid, old.name, old.prompt);
		END;
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TRIGGER IF NOT EXISTS sections_bytes_ai AFTER INSERT ON sections BEGIN
			UPDATE meta SET value = value + LENGTH(new.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS sections_bytes_au AFTER UPDATE ON sections BEGIN
			UPDATE meta SET value = value + LENGTH(new.content) - LENGTH(old.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS sections_bytes_ad AFTER DELETE ON sections BEGIN
			UPDATE meta SET value = value - LENGTH(old.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS refs_bytes_ai AFTER INSERT ON refs BEGIN
			UPDATE meta SET value = value + LENGTH(new.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS refs_bytes_au AFTER UPDATE ON refs BEGIN
			UPDATE meta SET value = value + LENGTH(new.content) - LENGTH(old.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS refs_bytes_ad AFTER DELETE ON refs BEGIN
			UPDATE meta SET value = value - LENGTH(old.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS routines_bytes_ai AFTER INSERT ON routines BEGIN
			UPDATE meta SET value = value + LENGTH(new.prompt) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS routines_bytes_au AFTER UPDATE ON routines BEGIN
			UPDATE meta SET value = value + LENGTH(new.prompt) - LENGTH(old.prompt) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS routines_bytes_ad AFTER DELETE ON routines BEGIN
			UPDATE meta SET value = value - LENGTH(old.prompt) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS open_items_bytes_ai AFTER INSERT ON open_items BEGIN
			UPDATE meta SET value = value + LENGTH(new.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS open_items_bytes_au AFTER UPDATE ON open_items BEGIN
			UPDATE meta SET value = value + LENGTH(new.content) - LENGTH(old.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS open_items_bytes_ad AFTER DELETE ON open_items BEGIN
			UPDATE meta SET value = value - LENGTH(old.content) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS metrics_bytes_ai AFTER INSERT ON metrics BEGIN
			UPDATE meta SET value = value + LENGTH(new.name) + LENGTH(COALESCE(new.unit, '')) + LENGTH(COALESCE(new.note, '')) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS metrics_bytes_ad AFTER DELETE ON metrics BEGIN
			UPDATE meta SET value = value - LENGTH(old.name) - LENGTH(COALESCE(old.unit, '')) - LENGTH(COALESCE(old.note, '')) WHERE key = 'content_bytes';
		END;
		${CHANGES_TABLE_SQL}
		CREATE TRIGGER IF NOT EXISTS sections_hist_ad AFTER DELETE ON sections BEGIN
			INSERT INTO changes(kind, name, op, old_text)
				VALUES ('section', old.name, 'delete', old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS refs_hist_ad AFTER DELETE ON refs BEGIN
			INSERT INTO changes(kind, name, op, old_text)
				VALUES ('ref', old.name, 'delete', old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS routines_hist_ad AFTER DELETE ON routines BEGIN
			INSERT INTO changes(kind, name, op, old_text)
				VALUES ('routine', old.name, 'delete',
					'cadence: ' || old.cadence || char(10) || 'status: ' || old.status
						|| char(10) || char(10) || old.prompt);
		END;
		${JOURNAL_INDEX_SQL}
	`);
  // Databases created before the 'script' change kind get their CHECK rebuilt
  // once. Must run before any script write (or delete-trigger fire) can insert
  // a 'script' row — i.e. here, on open, right after the trigger families.
  migrateChangesKindCheck(db);
  // Additive column migrations: ALTER TABLE has no IF NOT EXISTS, so probe
  // table_info first — the same self-applying spirit as the trigger families.
  const openItemCols = db.pragma("table_info(open_items)") as Array<{ name: string }>;
  if (!openItemCols.some((c) => c.name === "resolved_note")) {
    db.exec("ALTER TABLE open_items ADD COLUMN resolved_note TEXT");
  }
  const metricCols = db.pragma("table_info(metrics)") as Array<{ name: string }>;
  if (!metricCols.some((c) => c.name === "valid_to")) {
    db.exec("ALTER TABLE metrics ADD COLUMN valid_to TEXT");
  }
  const journalCols = db.pragma("table_info(journal)") as Array<{ name: string }>;
  if (!journalCols.some((c) => c.name === "correction")) {
    db.exec("ALTER TABLE journal ADD COLUMN correction TEXT");
    db.exec("ALTER TABLE journal ADD COLUMN corrected_at TEXT");
  }
  if (!journalCols.some((c) => c.name === "archived_at")) {
    db.exec("ALTER TABLE journal ADD COLUMN archived_at TEXT");
  }
  // Must follow the column probes above — the rebuilt index reads `correction`.
  migrateJournalIndex(db);
  migrateDropScripts(db);
}

/**
 * The journal index widened from `entry` to `entry, correction` when journal
 * corrections arrived. An FTS5 table cannot gain a column and a trigger body
 * cannot be altered, so a database created before that keeps indexing only
 * the original text — a correction would be invisible to `search_knowledge`
 * and uncounted by the quota. Rebuild once: drop the trigger family and the
 * index, recreate both from `JOURNAL_INDEX_SQL`, repopulate from the base
 * table. Every later open sees `correction` in the stored SQL and returns.
 */
function migrateJournalIndex(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal_fts'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("correction")) return;
  db.transaction(() => {
    for (const trigger of [
      "journal_ai",
      "journal_au",
      "journal_ad",
      "journal_bytes_ai",
      "journal_bytes_au",
      "journal_bytes_ad",
      "journal_hist_ad",
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.exec("DROP TABLE IF EXISTS journal_fts");
    db.exec(JOURNAL_INDEX_SQL);
    db.exec("INSERT INTO journal_fts(journal_fts) VALUES('rebuild')");
  })();
}

/**
 * v3: the script store is retired — analysis code lives in the assistant's
 * own environment (a versioned repo), not in the coaching DB. Databases from
 * v2 still carry the table; retire it WITHOUT losing content: every stored
 * script lands in the change history as a delete record (the same recovery
 * path every other removal uses — `list_changes kind:'script'`), then the
 * table, its FTS index and all seven trigger family members are dropped.
 * Triggers are dropped FIRST so this is deterministic regardless of which
 * trigger generation the legacy DB carries; the quota counter self-heals via
 * recomputeContentBytes on the same open. Runs once — the table probe makes
 * every later open a no-op.
 */
function migrateDropScripts(db: Database.Database): void {
  const hasScripts =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scripts'").get() !==
    undefined;
  if (!hasScripts) return;
  db.transaction(() => {
    for (const trigger of [
      "scripts_ai",
      "scripts_au",
      "scripts_ad",
      "scripts_bytes_ai",
      "scripts_bytes_au",
      "scripts_bytes_ad",
      "scripts_hist_ad",
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.exec(`
			INSERT INTO changes(kind, name, op, old_text)
				SELECT 'script', name, 'delete',
					'language: ' || language || char(10) || 'description: ' || description
						|| char(10) || char(10) || code
				FROM scripts;
			DROP TABLE IF EXISTS scripts_fts;
			DROP TABLE scripts;
		`);
  })();
}

export function seedFromDirectory(db: Database.Database, seedDir: string): void {
  if (!existsSync(seedDir)) return;
  const count = (db.prepare("SELECT COUNT(*) as n FROM sections").get() as { n: number }).n;
  if (count > 0) return;

  const skillPath = join(seedDir, "SKILL.md");
  if (!existsSync(skillPath)) return;

  const insertSection = db.prepare("INSERT INTO sections(name, content) VALUES (?, ?)");
  const insertRef = db.prepare("INSERT INTO refs(name, content) VALUES (?, ?)");

  const refsDir = join(seedDir, "references");
  const refFiles = existsSync(refsDir)
    ? readdirSync(refsDir)
        .sort()
        .filter((f) => f.endsWith(".md"))
    : [];

  db.transaction(() => {
    insertSection.run("main", readFileSync(skillPath, "utf-8"));
    for (const file of refFiles) {
      insertRef.run(file.replace(/\.md$/, ""), readFileSync(join(refsDir, file), "utf-8"));
    }
    // Stamp the seed-update watermark: a freshly onboarded user is current by
    // definition and must never be told to apply ledger entries that predate
    // their own seeding. Pre-feature DBs lack the key and read as 0.
    setAppliedUpdateId(db, latestUpdateId(loadSeedUpdates(seedDir) ?? []));
  })();
}
