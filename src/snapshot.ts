import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SnapshotOptions = {
  db: string;
  outDir: string;
  seedOnly?: boolean;
};

export type SnapshotDoc = { path: string; content: string };

type SectionRow = { name: string; content: string; updated_at: string };
type RefRow = { name: string; content: string; updated_at: string };
type JournalRow = { entry: string; created_at: string };
type OpenItemRow = {
  id: number;
  kind: string;
  content: string;
  status: string;
  relevant_date: string | null;
  resolved_note: string | null;
};
type RoutineRow = { name: string; cadence: string; prompt: string; status: string };
type ScriptRow = {
  name: string;
  description: string;
  language: string;
  code: string;
  requires: string | null;
  verified_at: string | null;
};
type MetricRow = {
  name: string;
  value: number;
  unit: string | null;
  note: string | null;
  measured_at: string;
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
      `## #${r.id} [${r.kind}/${r.status}]${r.relevant_date ? ` (${r.relevant_date})` : ""}\n\n${r.content}\n` +
      (r.resolved_note ? `\n> resolved: ${r.resolved_note}\n` : ""),
  );
  return `# Open Items\n\n${blocks.join("\n---\n\n")}`;
}

function formatMetrics(rows: MetricRow[]): string {
  if (rows.length === 0) return "# Metrics\n\n_No metrics._\n";
  const byName = new Map<string, MetricRow[]>();
  for (const r of rows) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  const blocks = [...byName.entries()].map(
    ([name, points]) =>
      `## ${name}\n\n` +
      points
        .map(
          (p) =>
            `- ${p.measured_at} · ${p.value}${p.unit ? ` ${p.unit}` : ""}${p.note ? ` — ${p.note}` : ""}`,
        )
        .join("\n") +
      "\n",
  );
  return `# Metrics\n\n${blocks.join("\n")}`;
}

function formatScripts(rows: ScriptRow[]): string {
  if (rows.length === 0) return "# Scripts\n\n_No scripts._\n";
  const blocks = rows.map(
    (r) =>
      `## ${r.name} (${r.language})${r.verified_at ? ` — verified ${r.verified_at}` : " — unverified"}\n\n` +
      `${r.description}\n` +
      (r.requires ? `\nRequires: ${r.requires}\n` : "") +
      `\n\`\`\`${r.language === "python" ? "python" : ""}\n${r.code}\n\`\`\`\n`,
  );
  return `# Scripts\n\n${blocks.join("\n---\n\n")}`;
}

function formatRoutines(rows: RoutineRow[]): string {
  if (rows.length === 0) return "# Routines\n\n_No routines._\n";
  const blocks = rows.map(
    (r) => `## ${r.name} [${r.status}]\n\nCadence: ${r.cadence}\n\n${r.prompt}\n`,
  );
  return `# Routines\n\n${blocks.join("\n---\n\n")}`;
}

/**
 * Produce the markdown documents (with relative paths) that make up a snapshot
 * of the given live DB handle. Shared by `runSnapshot` (writes them to disk)
 * and the account-page export (zips them in memory). Does NOT include the
 * binary `skill.db` copy — callers add that via `db.backup()` / `db.serialize()`.
 */
export function snapshotDocuments(db: Database.Database, seedOnly = false): SnapshotDoc[] {
  const docs: SnapshotDoc[] = [];
  // Sidecar timestamp record. The .md files stay byte-identical to DB content (restore's
  // "unchanged" detection depends on that), so the per-doc `updated_at` lives here instead of
  // in per-file frontmatter. It lists exactly the docs whose files were emitted, letting
  // `coaching-mcp-restore` refuse to overwrite a live doc that is newer than this seed.
  const manifest: {
    snapshot_at: string;
    sections: Record<string, string>;
    refs: Record<string, string>;
  } = { snapshot_at: "", sections: {}, refs: {} };
  manifest.snapshot_at = (db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now;

  const sections = db
    .prepare("SELECT name, content, updated_at FROM sections ORDER BY name")
    .all() as SectionRow[];
  for (const s of sections) {
    if (s.name === "main") {
      docs.push({ path: "SKILL.md", content: s.content });
      manifest.sections[s.name] = s.updated_at;
    } else if (!seedOnly) {
      docs.push({ path: join("sections", `${s.name}.md`), content: s.content });
      manifest.sections[s.name] = s.updated_at;
    }
  }

  const refs = db
    .prepare("SELECT name, content, updated_at FROM refs ORDER BY name")
    .all() as RefRow[];
  for (const r of refs) {
    docs.push({ path: join("references", `${r.name}.md`), content: r.content });
    manifest.refs[r.name] = r.updated_at;
  }

  docs.push({ path: "seed-manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` });

  if (!seedOnly) {
    const journal = db
      .prepare("SELECT entry, created_at FROM journal ORDER BY created_at DESC, id DESC")
      .all() as JournalRow[];
    docs.push({ path: "journal.md", content: formatJournal(journal) });

    // resolved_note arrives via an additive migration on server open; this CLI
    // may read (readonly!) a DB that predates it — probe before selecting.
    const itemCols = db.pragma("table_info(open_items)") as Array<{ name: string }>;
    const noteExpr = itemCols.some((c) => c.name === "resolved_note")
      ? "resolved_note"
      : "NULL AS resolved_note";
    const openItems = db
      .prepare(
        `SELECT id, kind, content, status, relevant_date, ${noteExpr} FROM open_items ORDER BY id DESC`,
      )
      .all() as OpenItemRow[];
    docs.push({ path: "open-items.md", content: formatOpenItems(openItems) });

    const routines = db
      .prepare("SELECT name, cadence, prompt, status FROM routines ORDER BY name")
      .all() as RoutineRow[];
    docs.push({ path: "routines.md", content: formatRoutines(routines) });

    // The CLI may point at a DB no server has opened since the scripts table
    // shipped (createSchema runs on open, snapshot must not mutate) — probe.
    const hasScripts =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scripts'").get() !==
      undefined;
    if (hasScripts) {
      const scripts = db
        .prepare(
          "SELECT name, description, language, code, requires, verified_at FROM scripts ORDER BY name",
        )
        .all() as ScriptRow[];
      if (scripts.length > 0) {
        docs.push({ path: "scripts.md", content: formatScripts(scripts) });
      }
    }

    // The CLI may point at a DB no server has opened since the metrics table
    // shipped (createSchema runs on open, snapshot must not mutate) — probe.
    const hasMetrics =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metrics'").get() !==
      undefined;
    if (hasMetrics) {
      const metrics = db
        .prepare(
          "SELECT name, value, unit, note, measured_at FROM metrics ORDER BY name, measured_at, id",
        )
        .all() as MetricRow[];
      if (metrics.length > 0) {
        docs.push({ path: "metrics.md", content: formatMetrics(metrics) });
      }
    }
  }

  return docs;
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
    for (const doc of snapshotDocuments(db, seedOnly)) {
      written.push(writeContent(join(outDir, doc.path), doc.content));
    }

    if (!seedOnly) {
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
