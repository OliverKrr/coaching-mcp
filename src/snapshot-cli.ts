#!/usr/bin/env node
import { join } from "node:path";
import { runSnapshot } from "./snapshot.js";

function usage(): void {
  process.stderr.write(
    "Usage: coaching-mcp-snapshot [outDir] [--db <path>] [--seed-only]\n" +
      "  outDir       output directory (default: ./snapshots)\n" +
      "  --db <path>  source SQLite file (default: $DATA_DIR/skill.db, else /data/skill.db)\n" +
      "  --seed-only  emit only SKILL.md + references/*.md (seed files)\n" +
      "\n" +
      "Always writes seed-manifest.json (per-doc updated_at) so coaching-mcp-restore can\n" +
      "refuse to overwrite a live doc that is newer than this seed.\n",
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let outDir = "./snapshots";
  let dbPath = join(process.env.DATA_DIR ?? "/data", "skill.db");
  let seedOnly = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed-only") {
      seedOnly = true;
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
  if (positional.length > 0) outDir = positional[0];

  try {
    const written = await runSnapshot({ db: dbPath, outDir, seedOnly });
    process.stdout.write(`wrote ${written.length} files to ${outDir}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`snapshot failed: ${(err as Error).message}\n`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
