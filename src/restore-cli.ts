#!/usr/bin/env node
import { join } from "node:path";
import { runRestore } from "./restore.js";

function usage(): void {
  process.stderr.write(
    "Usage: coaching-mcp-restore [seedDir] [--db <path>]\n" +
      "  seedDir      seed directory to apply (default: /seed)\n" +
      "  --db <path>  target SQLite file (default: $DATA_DIR/skill.db, else /data/skill.db)\n" +
      "\n" +
      "Upserts sections (SKILL.md → 'main', sections/*.md) and references (references/*.md)\n" +
      "from the seed dir into the live DB. The journal and open_items tables are preserved.\n" +
      "It overwrites section/ref content from files — snapshot first if the DB may have diverged.\n",
  );
}

function summary(label: string, names: string[]): string {
  return names.length > 0 ? `${label}: ${names.join(", ")}` : "";
}

function main(): number {
  const argv = process.argv.slice(2);
  let seedDir = "/seed";
  let dbPath = join(process.env.DATA_DIR ?? "/data", "skill.db");
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
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
    const { created, changed, unchanged } = runRestore({ db: dbPath, seedDir });
    const details = [
      summary("created", created),
      summary("changed", changed),
      summary("unchanged", unchanged),
    ].filter((s) => s.length > 0);
    const tail = details.length > 0 ? ` (${details.join("; ")})` : "";
    process.stdout.write(
      `restore: ${created.length} created, ${changed.length} changed, ${unchanged.length} unchanged${tail}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`restore failed: ${(err as Error).message}\n`);
    return 1;
  }
}

process.exit(main());
