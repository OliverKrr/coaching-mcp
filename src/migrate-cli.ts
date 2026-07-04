#!/usr/bin/env node
import { runMigrate } from "./migrate.js";

function usage(): never {
  process.stderr.write(
    `Usage: coaching-mcp-migrate --email <address> [--data-dir <dir>] [--dry-run]

Adopt a legacy single-user database (DATA_DIR/skill.db) into the multi-user
layout (DATA_DIR/users/<id>/skill.db + user registry in auth.db).

  --email     Email address the legacy data belongs to (must match the address
              the user will sign in with).
  --data-dir  Data directory (default: $DATA_DIR or /data).
  --dry-run   Print the plan without changing anything.
`,
  );
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  let email = "";
  let dataDir = process.env.DATA_DIR ?? "/data";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") email = argv[++i] ?? "";
    else if (arg === "--data-dir") dataDir = argv[++i] ?? "";
    else if (arg === "--dry-run") dryRun = true;
    else usage();
  }
  if (!email || !dataDir) usage();

  const result = runMigrate({ email, dataDir, dryRun });
  if (!result.wrote) {
    process.stdout.write(
      `DRY RUN — no changes written.\nWould register a user for ${email.toLowerCase()} and move ${result.from} -> ${result.to}\n`,
    );
    return;
  }
  process.stdout.write(
    `Migrated ${result.from} -> ${result.to}\nUser id: ${result.userId} (${email.toLowerCase()})\nThe IdP identity links automatically on first login.\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
