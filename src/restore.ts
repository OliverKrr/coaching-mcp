import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RestoreOptions = {
  db: string;
  seedDir: string;
};

export type RestoreResult = {
  created: string[];
  changed: string[];
  unchanged: string[];
};

type WorkItem = { table: "sections" | "refs"; name: string; content: string };
type Row = { content: string } | undefined;

const UPSERT_SQL = {
  sections:
    "INSERT INTO sections(name, content) VALUES (?, ?)" +
    " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
  refs:
    "INSERT INTO refs(name, content) VALUES (?, ?)" +
    " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
} as const;

/**
 * Apply a seed directory's content into a live coaching-mcp DB — the inverse of `runSnapshot`.
 *
 * Upserts the `sections` and `refs` tables from `SKILL.md` (→ section 'main'),
 * `sections/*.md` (→ sections by basename), and `references/*.md` (→ refs by basename).
 * Identical rows are left untouched (no write, so `updated_at` is preserved); only real
 * changes upsert, firing the FTS triggers. The `journal` and `open_items` tables are never
 * read or written.
 *
 * Operates on a local file path only — no SSH/Docker/host knowledge.
 */
export function runRestore(opts: RestoreOptions): RestoreResult {
  const { db: dbPath, seedDir } = opts;
  if (!existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }
  if (!existsSync(seedDir)) {
    throw new Error(`seed directory not found: ${seedDir}`);
  }

  const items: WorkItem[] = [];

  const skillPath = join(seedDir, "SKILL.md");
  if (existsSync(skillPath)) {
    items.push({ table: "sections", name: "main", content: readFileSync(skillPath, "utf8") });
  }

  const sectionsDir = join(seedDir, "sections");
  if (existsSync(sectionsDir)) {
    for (const file of readdirSync(sectionsDir)
      .sort()
      .filter((f) => f.endsWith(".md"))) {
      items.push({
        table: "sections",
        name: file.replace(/\.md$/, ""),
        content: readFileSync(join(sectionsDir, file), "utf8"),
      });
    }
  }

  const refsDir = join(seedDir, "references");
  if (existsSync(refsDir)) {
    for (const file of readdirSync(refsDir)
      .sort()
      .filter((f) => f.endsWith(".md"))) {
      items.push({
        table: "refs",
        name: file.replace(/\.md$/, ""),
        content: readFileSync(join(refsDir, file), "utf8"),
      });
    }
  }

  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");

    const result: RestoreResult = { created: [], changed: [], unchanged: [] };

    const selectSection = db.prepare("SELECT content FROM sections WHERE name = ?");
    const selectRef = db.prepare("SELECT content FROM refs WHERE name = ?");
    const upsertSection = db.prepare(UPSERT_SQL.sections);
    const upsertRef = db.prepare(UPSERT_SQL.refs);

    db.transaction(() => {
      for (const item of items) {
        const existing = (
          item.table === "sections" ? selectSection.get(item.name) : selectRef.get(item.name)
        ) as Row;
        if (existing === undefined) {
          (item.table === "sections" ? upsertSection : upsertRef).run(item.name, item.content);
          result.created.push(item.name);
        } else if (existing.content !== item.content) {
          (item.table === "sections" ? upsertSection : upsertRef).run(item.name, item.content);
          result.changed.push(item.name);
        } else {
          result.unchanged.push(item.name);
        }
      }
    })();

    return result;
  } finally {
    db.close();
  }
}
