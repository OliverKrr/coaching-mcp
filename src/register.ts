import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import type { WriteLimits } from "./quota.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerEditTools } from "./tools/edit.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerOpenItemsTools } from "./tools/openitems.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerReadTools } from "./tools/read.js";
import { registerRoutineTools } from "./tools/routines.js";
import { registerScriptTools } from "./tools/scripts.js";
import { registerSeedUpdateTools } from "./tools/seed-updates.js";
import { registerSessionTools } from "./tools/session.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTopicTools } from "./topics.js";

/**
 * The core (user-agnostic) tool set, shared by every entry point: the stdio
 * single-user server, each multi-user HTTP session, and the local CLI. One
 * list, so the surfaces can never drift; serve-only tools (quota requests,
 * notify, integrations, gateways) are layered on top by mcp-http.ts.
 */
export function registerCoreTools(
  server: McpServer,
  db: Database.Database,
  opts: { limits?: WriteLimits; seedDir?: string; log?: (msg: string) => void } = {},
): void {
  const { limits, seedDir, log = () => {} } = opts;
  registerSessionTools(server, db, limits, seedDir);
  registerReadTools(server, db, limits, seedDir);
  registerWriteTools(server, db, limits);
  registerEditTools(server, db, limits);
  registerHistoryTools(server, db);
  registerOpsTools(server, db, limits, seedDir);
  registerDeleteTools(server, db);
  registerOpenItemsTools(server, db, limits);
  registerMetricsTools(server, db, limits);
  registerRoutineTools(server, db, limits);
  registerScriptTools(server, db, limits);
  // Seed-dir-dependent tools: absent without a seed dir (the structural-
  // opt-in pattern) — a CLI pointed at a bare DB has no packs or ledger.
  if (seedDir !== undefined) {
    registerTopicTools(server, seedDir);
    registerSeedUpdateTools(server, db, seedDir, limits, log);
  }
}
