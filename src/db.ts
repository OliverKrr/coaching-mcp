import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Section = { name: string; content: string; updated_at: string };
export type Reference = { name: string; content: string; updated_at: string };
export type JournalEntry = { id: number; entry: string; created_at: string };
export type OpenItem = {
  id: number;
  kind: "commitment" | "flag";
  content: string;
  status: "open" | "done" | "dismissed";
  source: string | null;
  dedup_key: string | null;
  relevant_date: string | null;
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
  return db;
}

/**
 * Quota metric: total stored content characters (SQLite LENGTH semantics)
 * across every user-authored table. The `*_bytes_*` triggers keep the counter
 * in the same transaction as each write; this full recompute on every open
 * self-heals any drift and initializes pre-counter databases.
 */
export function recomputeContentBytes(db: Database.Database): void {
  const n = (
    db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM sections)
				+ (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM refs)
				+ (SELECT COALESCE(SUM(LENGTH(entry)), 0) FROM journal)
				+ (SELECT COALESCE(SUM(LENGTH(prompt)), 0) FROM routines)
				+ (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM open_items) AS n`,
      )
      .get() as { n: number }
  ).n;
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('content_bytes', ?)" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(n);
}

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
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
		CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
			name UNINDEXED, content,
			content=sections, content_rowid=rowid
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS refs_fts USING fts5(
			name UNINDEXED, content,
			content=refs, content_rowid=rowid
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
			entry,
			content=journal, content_rowid=id
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
		CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal BEGIN
			INSERT INTO journal_fts(rowid, entry) VALUES (new.id, new.entry);
		END;
		CREATE TRIGGER IF NOT EXISTS journal_au AFTER UPDATE ON journal BEGIN
			INSERT INTO journal_fts(journal_fts, rowid, entry)
				VALUES ('delete', old.id, old.entry);
			INSERT INTO journal_fts(rowid, entry) VALUES (new.id, new.entry);
		END;
		CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
			INSERT INTO sections_fts(sections_fts, rowid, name, content)
				VALUES ('delete', old.rowid, old.name, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS refs_ad AFTER DELETE ON refs BEGIN
			INSERT INTO refs_fts(refs_fts, rowid, name, content)
				VALUES ('delete', old.rowid, old.name, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS journal_ad AFTER DELETE ON journal BEGIN
			INSERT INTO journal_fts(journal_fts, rowid, entry)
				VALUES ('delete', old.id, old.entry);
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
		CREATE TRIGGER IF NOT EXISTS journal_bytes_ai AFTER INSERT ON journal BEGIN
			UPDATE meta SET value = value + LENGTH(new.entry) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS journal_bytes_au AFTER UPDATE ON journal BEGIN
			UPDATE meta SET value = value + LENGTH(new.entry) - LENGTH(old.entry) WHERE key = 'content_bytes';
		END;
		CREATE TRIGGER IF NOT EXISTS journal_bytes_ad AFTER DELETE ON journal BEGIN
			UPDATE meta SET value = value - LENGTH(old.entry) WHERE key = 'content_bytes';
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
	`);
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
  })();
}
