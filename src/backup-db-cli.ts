#!/usr/bin/env node
import { runBackupDb } from "./backup-db.js";

function usage(): void {
  process.stderr.write(
    "Usage: coaching-mcp-backup-db <src> <dest>\n" +
      "  src   source SQLite file (e.g. an auth/registry DB)\n" +
      "  dest  destination file for the consistent online-backup copy\n" +
      "\n" +
      "Uses SQLite's online backup API (WAL-safe); overwrites dest if present.\n" +
      "For the schema-aware knowledge-base dump use coaching-mcp-snapshot instead.\n",
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") {
      usage();
      return 0;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`unknown option: ${a}\n`);
      usage();
      return 2;
    }
    positional.push(a);
  }
  if (positional.length !== 2) {
    usage();
    return 2;
  }

  const [src, dest] = positional;
  try {
    const written = await runBackupDb({ src, dest });
    process.stdout.write(`backed up ${src} -> ${written}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`backup failed: ${(err as Error).message}\n`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
