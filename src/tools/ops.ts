// coaching-mcp/src/tools/ops.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { historyBytes } from "../history.js";
import { contentBytes, type WriteLimits } from "../quota.js";
import { appliedUpdateId, latestUpdateId, loadSeedUpdates } from "../seed-updates.js";
import { toolText, withErrorHandling } from "../utils/errors.js";

function loadVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src layout: src/tools/ops.ts → ../../package.json
  // dist layout: dist/index.js (bundled) → ../package.json
  const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
  for (const p of candidates) {
    try {
      return (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
    } catch {
      // try next candidate
    }
  }
  return "unknown";
}

const PACKAGE_VERSION = loadVersion();

export function registerOpsTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
  seedDir?: string,
): void {
  server.registerTool(
    "get_version",
    {
      title: "Get server version & stats",
      description:
        "Get coaching-mcp build info and DB statistics, including storage usage against the account's quota. Useful to confirm deployments and spot-check database health.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      withErrorHandling("get_version", () => {
        const sectionsCount = (
          db.prepare("SELECT COUNT(*) as n FROM sections").get() as { n: number }
        ).n;
        const refsCount = (db.prepare("SELECT COUNT(*) as n FROM refs").get() as { n: number }).n;
        const journalCount = (
          db.prepare("SELECT COUNT(*) as n FROM journal").get() as { n: number }
        ).n;
        const routinesCount = (
          db.prepare("SELECT COUNT(*) as n FROM routines").get() as { n: number }
        ).n;
        const changesCount = (
          db.prepare("SELECT COUNT(*) as n FROM changes").get() as { n: number }
        ).n;
        const dbPath = `${process.env.DATA_DIR ?? "/data"}/skill.db`;
        let dbSizeBytes = 0;
        try {
          dbSizeBytes = statSync(dbPath).size;
        } catch {
          // in-memory db (tests) — leave at 0
        }
        const storageBytes = contentBytes(db);
        const seedUpdates = seedDir !== undefined ? loadSeedUpdates(seedDir) : null;
        const info = {
          name: "coaching-mcp",
          version: PACKAGE_VERSION,
          node_version: process.version,
          db_path: dbPath,
          sections_count: sectionsCount,
          refs_count: refsCount,
          journal_count: journalCount,
          routines_count: routinesCount,
          changes_count: changesCount,
          db_size_bytes: dbSizeBytes,
          storage_bytes: storageBytes,
          history_bytes: historyBytes(db),
          ...(seedUpdates !== null
            ? {
                seed_updates_latest: latestUpdateId(seedUpdates),
                seed_updates_applied: appliedUpdateId(db),
              }
            : {}),
          ...(limits
            ? {
                storage_quota_bytes: limits.quotaBytes,
                storage_used_percent: Math.round((storageBytes / limits.quotaBytes) * 100),
              }
            : {}),
        };
        return toolText(JSON.stringify(info, null, 2));
      }),
  );
}
