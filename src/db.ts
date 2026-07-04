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
  return db;
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
