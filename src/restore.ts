import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureChangesSchema, logReplace } from "./history.js";

export type RestoreOptions = {
  db: string;
  seedDir: string;
  /** When true, open the DB read-only and report the plan without writing anything. */
  dryRun?: boolean;
  /** When true, overwrite even docs the guard flags as conflicts (live newer than the seed). */
  force?: boolean;
};

/** A doc the seed would overwrite whose live copy is newer than the seed captured it. */
export type Conflict = {
  table: "sections" | "refs";
  name: string;
  liveUpdatedAt: string;
  /** The seed manifest's timestamp for this doc, or null when the manifest has no entry for it. */
  seedUpdatedAt: string | null;
};

export type RestoreResult = {
  created: string[];
  changed: string[];
  unchanged: string[];
  /** Docs the seed would clobber with older content. Empty in legacy mode (no manifest). */
  conflicts: Conflict[];
  /** Whether the DB was actually written (false on dry-run and on a blocked, unforced conflict). */
  wrote: boolean;
  /** True when --force overwrote at least one conflict. */
  forced: boolean;
};

type WorkItem = {
  table: "sections" | "refs";
  name: string;
  content: string;
  /** Live content this item overwrites — logged to change history. Absent on creates. */
  oldContent?: string;
};
type Row = { content: string; updated_at: string } | undefined;
type SeedManifest = { sections: Record<string, string>; refs: Record<string, string> };

const UPSERT_SQL = {
  sections:
    "INSERT INTO sections(name, content) VALUES (?, ?)" +
    " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
  refs:
    "INSERT INTO refs(name, content) VALUES (?, ?)" +
    " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
} as const;

/**
 * Read `seed-manifest.json` from the seed dir. Returns null when absent (→ legacy mode, guard off).
 * Throws on a present-but-unparseable manifest so a corrupt file never silently disables the guard.
 */
function readManifest(seedDir: string): SeedManifest | null {
  const path = join(seedDir, "seed-manifest.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `seed-manifest.json is present but could not be parsed: ${(err as Error).message}`,
    );
  }
  const obj = (parsed ?? {}) as Partial<SeedManifest>;
  return { sections: obj.sections ?? {}, refs: obj.refs ?? {} };
}

/**
 * Apply a seed directory's content into a live coaching-mcp DB — the inverse of `runSnapshot`.
 *
 * Upserts the `sections` and `refs` tables from `SKILL.md` (→ section 'main'),
 * `sections/*.md` (→ sections by basename), and `references/*.md` (→ refs by basename).
 * Identical rows are left untouched (no write, so `updated_at` is preserved); only real
 * changes upsert, firing the FTS triggers. The `journal` and `open_items` tables are never
 * read or written.
 *
 * Clobber guard: if the seed dir has a `seed-manifest.json`, a doc whose content differs is a
 * **conflict** when the live `updated_at` is newer than the manifest's timestamp for it (or the
 * manifest has no entry for it). Conflicts abort the whole write unless `force` is set. With no
 * manifest the guard is off (legacy behaviour). `created` docs (absent from live) always apply.
 *
 * With `dryRun: true` the DB is opened read-only, the plan (incl. conflicts) is computed, but
 * nothing is written — a safe preview. Operates on a local file path only — no SSH/Docker.
 */
export function runRestore(opts: RestoreOptions): RestoreResult {
  const { db: dbPath, seedDir, dryRun = false, force = false } = opts;
  if (!existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }
  if (!existsSync(seedDir)) {
    throw new Error(`seed directory not found: ${seedDir}`);
  }

  const manifest = readManifest(seedDir);

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

  const db = dryRun
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : new Database(dbPath);
  try {
    if (!dryRun) {
      db.pragma("busy_timeout = 5000");
      db.pragma("journal_mode = WAL");
    }

    const selectSection = db.prepare("SELECT content, updated_at FROM sections WHERE name = ?");
    const selectRef = db.prepare("SELECT content, updated_at FROM refs WHERE name = ?");

    // Classify every item read-only, splitting content changes into safe writes vs. conflicts.
    const result: RestoreResult = {
      created: [],
      changed: [],
      unchanged: [],
      conflicts: [],
      wrote: false,
      forced: false,
    };
    const toWrite: WorkItem[] = []; // created + safe changes
    const conflictItems: WorkItem[] = []; // content differs AND live is newer than the seed

    for (const item of items) {
      const existing = (
        item.table === "sections" ? selectSection.get(item.name) : selectRef.get(item.name)
      ) as Row;

      if (existing === undefined) {
        result.created.push(item.name);
        toWrite.push(item);
        continue;
      }
      if (existing.content === item.content) {
        result.unchanged.push(item.name);
        continue;
      }
      // Content differs → it would overwrite. Guard it against the manifest, if present.
      item.oldContent = existing.content;
      if (manifest === null) {
        result.changed.push(item.name); // legacy mode: no timestamp signal, apply as before
        toWrite.push(item);
        continue;
      }
      const seedUpdatedAt = manifest[item.table][item.name] ?? null;
      if (seedUpdatedAt === null || existing.updated_at > seedUpdatedAt) {
        result.conflicts.push({
          table: item.table,
          name: item.name,
          liveUpdatedAt: existing.updated_at,
          seedUpdatedAt,
        });
        conflictItems.push(item);
      } else {
        result.changed.push(item.name);
        toWrite.push(item);
      }
    }

    const shouldWrite = !dryRun && (result.conflicts.length === 0 || force);
    if (!shouldWrite) {
      return result; // dry-run, or a blocked unforced conflict — nothing written
    }

    const writeItems = force ? [...toWrite, ...conflictItems] : toWrite;
    // The DB may predate the change-history feature (this CLI targets live
    // DBs directly) — make sure the table exists before logging overwrites.
    ensureChangesSchema(db);
    const upsertSection = db.prepare(UPSERT_SQL.sections);
    const upsertRef = db.prepare(UPSERT_SQL.refs);
    db.transaction(() => {
      for (const item of writeItems) {
        (item.table === "sections" ? upsertSection : upsertRef).run(item.name, item.content);
        if (item.oldContent !== undefined) {
          logReplace(
            db,
            item.table === "sections" ? "section" : "ref",
            item.name,
            item.oldContent,
            item.content,
            "restore-cli",
          );
        }
      }
    })();

    result.wrote = true;
    result.forced = force && result.conflicts.length > 0;
    return result;
  } finally {
    db.close();
  }
}
