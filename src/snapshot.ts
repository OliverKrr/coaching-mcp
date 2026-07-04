import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SnapshotOptions = {
  db: string;
  outDir: string;
  seedOnly?: boolean;
};

type SectionRow = { name: string; content: string; updated_at: string };
type RefRow = { name: string; content: string; updated_at: string };
type JournalRow = { entry: string; created_at: string };
type OpenItemRow = {
  id: number;
  kind: string;
  content: string;
  status: string;
  relevant_date: string | null;
};

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

function formatOpenItems(rows: OpenItemRow[]): string {
  if (rows.length === 0) return "# Open Items\n\n_No items._\n";
  const blocks = rows.map(
    (r) =>
      `## #${r.id} [${r.kind}/${r.status}]${r.relevant_date ? ` (${r.relevant_date})` : ""}\n\n${r.content}\n`,
  );
  return `# Open Items\n\n${blocks.join("\n---\n\n")}`;
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
    // Sidecar timestamp record. The .md files stay byte-identical to DB content (restore's
    // "unchanged" detection depends on that), so the per-doc `updated_at` lives here instead of
    // in per-file frontmatter. It lists exactly the docs whose files were emitted, letting
    // `coaching-mcp-restore` refuse to overwrite a live doc that is newer than this seed.
    const manifest: {
      snapshot_at: string;
      sections: Record<string, string>;
      refs: Record<string, string>;
    } = { snapshot_at: "", sections: {}, refs: {} };
    manifest.snapshot_at = (
      db.prepare("SELECT datetime('now') AS now").get() as { now: string }
    ).now;

    const sections = db
      .prepare("SELECT name, content, updated_at FROM sections ORDER BY name")
      .all() as SectionRow[];
    for (const s of sections) {
      if (s.name === "main") {
        written.push(writeContent(join(outDir, "SKILL.md"), s.content));
        manifest.sections[s.name] = s.updated_at;
      } else if (!seedOnly) {
        written.push(writeContent(join(outDir, "sections", `${s.name}.md`), s.content));
        manifest.sections[s.name] = s.updated_at;
      }
    }

    const refs = db
      .prepare("SELECT name, content, updated_at FROM refs ORDER BY name")
      .all() as RefRow[];
    for (const r of refs) {
      written.push(writeContent(join(outDir, "references", `${r.name}.md`), r.content));
      manifest.refs[r.name] = r.updated_at;
    }

    written.push(
      writeContent(join(outDir, "seed-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    );

    if (!seedOnly) {
      const journal = db
        .prepare("SELECT entry, created_at FROM journal ORDER BY created_at DESC, id DESC")
        .all() as JournalRow[];
      written.push(writeContent(join(outDir, "journal.md"), formatJournal(journal)));

      const openItems = db
        .prepare("SELECT id, kind, content, status, relevant_date FROM open_items ORDER BY id DESC")
        .all() as OpenItemRow[];
      written.push(writeContent(join(outDir, "open-items.md"), formatOpenItems(openItems)));

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
