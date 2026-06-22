import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SnapshotOptions = {
  db: string;
  outDir: string;
  seedOnly?: boolean;
};

type SectionRow = { name: string; content: string };
type RefRow = { name: string; content: string };
type JournalRow = { entry: string; created_at: string };

function writeContent(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
  return path;
}

function formatJournal(rows: JournalRow[]): string {
  if (rows.length === 0) return "# Journal\n\n_No entries._\n";
  const blocks = rows.map((r) => `## ${r.created_at}\n\n${r.entry}\n`);
  return `# Journal\n\n${blocks.join("\n---\n\n")}`;
}

/**
 * Dump a coaching-mcp SQLite DB to `outDir`.
 *
 * Full mode: lossless `skill.db` (online backup, WAL-safe) + readable markdown
 * (SKILL.md, sections/, references/, journal.md).
 * Seed-only mode: just the files `seedFromDirectory()` consumes (SKILL.md + references/).
 *
 * Operates on a local file path only — no SSH/Docker/host knowledge.
 */
export async function runSnapshot(opts: SnapshotOptions): Promise<string[]> {
  const { db: dbPath, outDir, seedOnly = false } = opts;
  if (!existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }
  mkdirSync(outDir, { recursive: true });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const written: string[] = [];

    const sections = db
      .prepare("SELECT name, content FROM sections ORDER BY name")
      .all() as SectionRow[];
    for (const s of sections) {
      if (s.name === "main") {
        written.push(writeContent(join(outDir, "SKILL.md"), s.content));
      } else if (!seedOnly) {
        written.push(writeContent(join(outDir, "sections", `${s.name}.md`), s.content));
      }
    }

    const refs = db.prepare("SELECT name, content FROM refs ORDER BY name").all() as RefRow[];
    for (const r of refs) {
      written.push(writeContent(join(outDir, "references", `${r.name}.md`), r.content));
    }

    if (!seedOnly) {
      const journal = db
        .prepare("SELECT entry, created_at FROM journal ORDER BY created_at DESC, id DESC")
        .all() as JournalRow[];
      written.push(writeContent(join(outDir, "journal.md"), formatJournal(journal)));

      const backupPath = join(outDir, "skill.db");
      rmSync(backupPath, { force: true });
      await db.backup(backupPath);
      written.push(backupPath);
    }

    return written;
  } finally {
    db.close();
  }
}
