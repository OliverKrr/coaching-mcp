#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Conflict, runRestore } from "./restore.js";

function usage(): void {
  process.stderr.write(
    "Usage: coaching-mcp-restore [seedDir] [--db <path>] [--dry-run] [--force]\n" +
      "  seedDir      seed directory to apply (default: /seed)\n" +
      "  --db <path>  target SQLite file (default: $DATA_DIR/skill.db, else /data/skill.db)\n" +
      "  --dry-run    open the DB read-only and preview the plan; write nothing\n" +
      "  --force      overwrite even docs the guard flags as conflicts (live newer than the seed)\n" +
      "\n" +
      "Upserts sections (SKILL.md → 'main', sections/*.md) and references (references/*.md)\n" +
      "from the seed dir into the live DB. The journal and open_items tables are preserved.\n" +
      "Guard: with a seed-manifest.json present, a change is blocked when the live doc's\n" +
      "updated_at is newer than the seed's — snapshot first, or pass --force to override.\n",
  );
}

function summary(label: string, names: string[]): string {
  return names.length > 0 ? `${label}: ${names.join(", ")}` : "";
}

function conflictLines(conflicts: Conflict[]): string {
  return conflicts
    .map(
      (c) =>
        `  - ${c.table}/${c.name}: live ${c.liveUpdatedAt} is newer than seed ` +
        `${c.seedUpdatedAt ?? "(absent from manifest)"}`,
    )
    .join("\n");
}

function main(): number {
  const argv = process.argv.slice(2);
  let seedDir = "/seed";
  let dbPath = join(process.env.DATA_DIR ?? "/data", "skill.db");
  let dryRun = false;
  let force = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--db") {
      const next = argv[++i];
      if (next === undefined) {
        usage();
        return 2;
      }
      dbPath = next;
    } else if (a === "-h" || a === "--help") {
      usage();
      return 0;
    } else if (a.startsWith("-")) {
      process.stderr.write(`unknown option: ${a}\n`);
      usage();
      return 2;
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 0) seedDir = positional[0];

  try {
    if (!existsSync(join(seedDir, "seed-manifest.json"))) {
      process.stderr.write(
        "warning: no seed-manifest.json in the seed dir — clobber guard disabled. " +
          "Run coaching-mcp-snapshot to generate one.\n",
      );
    }

    const { created, changed, unchanged, conflicts, wrote, forced } = runRestore({
      db: dbPath,
      seedDir,
      dryRun,
      force,
    });

    // A guarded conflict blocks a real, unforced run: nothing was written, exit non-zero.
    if (conflicts.length > 0 && !dryRun && !force) {
      process.stderr.write(
        `restore ABORTED — the seed would overwrite ${conflicts.length} doc(s) newer in the live DB:\n` +
          `${conflictLines(conflicts)}\n` +
          "Nothing was written. Refresh the seed from the live DB (coaching-mcp-snapshot) and retry, " +
          "or re-run with --force to overwrite intentionally.\n",
      );
      return 1;
    }
    if (conflicts.length > 0) {
      // dry-run preview or a forced write — surface the conflicts without failing.
      process.stderr.write(
        `${dryRun ? "STALE SEED" : "FORCED OVERWRITE"} — ${conflicts.length} doc(s) newer in live than in the seed:\n` +
          `${conflictLines(conflicts)}\n`,
      );
    }

    const details = [
      summary("created", created),
      summary("changed", changed),
      summary("unchanged", unchanged),
      summary(
        "conflicts",
        conflicts.map((c) => c.name),
      ),
    ].filter((s) => s.length > 0);
    const tail = details.length > 0 ? ` (${details.join("; ")})` : "";
    if (dryRun) {
      process.stdout.write(
        `DRY RUN — no changes written. Would: ${created.length} created, ${changed.length} changed, ` +
          `${unchanged.length} unchanged, ${conflicts.length} conflict(s)${tail}\n` +
          "Run the write command to apply for real.\n",
      );
    } else {
      process.stdout.write(
        `restore: ${created.length} created, ${changed.length} changed, ${unchanged.length} unchanged` +
          `${forced ? `, ${conflicts.length} force-overwritten` : ""}${tail} (wrote=${wrote})\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`restore failed: ${(err as Error).message}\n`);
    return 1;
  }
}

process.exit(main());
