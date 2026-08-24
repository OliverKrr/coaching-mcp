import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { sdkInternals } from "./gateways.js";
import { NO_RESULTS_PREFIX } from "./utils/search.js";

/**
 * Tool-usage telemetry: aggregated per-day counters, never payloads. Every
 * tool definition a session carries costs context before the first exchange,
 * and the only defensible way to shrink the surface is to know what is
 * actually called — so the wrapper counts calls, errors, and empty search
 * results (the retrieval-miss log that decides whether semantic search over
 * the journal is ever justified). Counts-only is a privacy line, not an
 * implementation shortcut: arguments and results are user content and stay
 * out of the operator's view.
 *
 * Storage is the server-level auth/registry DB, not the per-user coaching DB —
 * telemetry is operational, must not count toward the user's quota, and the
 * operator question ("which tools are dead across all users?") is served by
 * one table, not N.
 */

/** Rows older than this are pruned on every server start. */
export const TOOL_USAGE_MAX_AGE_DAYS_DEFAULT = 180;

export function toolUsageMaxAgeDays(): number {
  const raw = Number(process.env.TOOL_USAGE_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : TOOL_USAGE_MAX_AGE_DAYS_DEFAULT;
}

export function createToolUsageSchema(db: Database.Database): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS tool_usage (
			day TEXT NOT NULL,
			user_id TEXT NOT NULL,
			tool TEXT NOT NULL,
			calls INTEGER NOT NULL DEFAULT 0,
			errors INTEGER NOT NULL DEFAULT 0,
			empty INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (day, user_id, tool)
		);
	`);
}

export type ToolCallOutcome = { error: boolean; empty: boolean };

export function recordToolUsage(
  db: Database.Database,
  userId: string,
  tool: string,
  outcome: ToolCallOutcome,
): void {
  db.prepare(
    `INSERT INTO tool_usage(day, user_id, tool, calls, errors, empty)
		VALUES (date('now'), ?, ?, 1, ?, ?)
		ON CONFLICT(day, user_id, tool) DO UPDATE SET
			calls = calls + 1,
			errors = errors + excluded.errors,
			empty = empty + excluded.empty`,
  ).run(userId, tool, outcome.error ? 1 : 0, outcome.empty ? 1 : 0);
}

export function pruneToolUsage(db: Database.Database, maxAgeDays = toolUsageMaxAgeDays()): void {
  db.prepare("DELETE FROM tool_usage WHERE day < date('now', ?)").run(`-${maxAgeDays} days`);
}

export type ToolUsageRow = {
  tool: string;
  calls: number;
  errors: number;
  empty: number;
  users: number;
  last_used: string;
};

/** Per-tool aggregate over the last `days`, most-called first. */
export function toolUsageSummary(db: Database.Database, days: number): ToolUsageRow[] {
  return db
    .prepare(
      `SELECT tool, SUM(calls) AS calls, SUM(errors) AS errors, SUM(empty) AS empty,
				COUNT(DISTINCT user_id) AS users, MAX(day) AS last_used
			FROM tool_usage WHERE day >= date('now', ?)
			GROUP BY tool ORDER BY calls DESC, tool`,
    )
    .all(`-${days} days`) as ToolUsageRow[];
}

/**
 * The telemetry key: the tool name, except search_knowledge, which splits by
 * its `type` scope — per-scope empty counts are the journal-retrieval-miss
 * evidence, and per-scope call counts show what actually gets searched.
 */
export function telemetryName(tool: string, args: unknown): string {
  if (tool !== "search_knowledge") return tool;
  const type = (args as { type?: unknown } | undefined)?.type;
  return typeof type === "string" ? `search_knowledge:${type}` : "search_knowledge:all";
}

function isEmptyResult(tool: string, result: CallToolResult): boolean {
  if (!tool.startsWith("search_knowledge") || result.isError) return false;
  const first = result.content?.[0];
  return first?.type === "text" && first.text.startsWith(NO_RESULTS_PREFIX);
}

/**
 * Wrap the session's stored tools/call handler with usage recording. Must be
 * installed AFTER every registration including attachGatewayTools, so the
 * captured handler is the final composed one and proxied gateway tools are
 * counted through the same choke point. Recording failures never break a
 * call; the call's own failure is still counted, then rethrown.
 */
export function instrumentToolCalls(
  server: McpServer,
  record: (tool: string, outcome: ToolCallOutcome) => void,
): void {
  const { handlers } = sdkInternals(server);
  const inner = handlers.get("tools/call");
  if (!inner) throw new Error("MCP SDK internals changed — tools/call handler not found");
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const key = telemetryName(req.params.name, req.params.arguments);
    try {
      const result = (await inner(req, extra)) as CallToolResult;
      try {
        record(key, { error: result.isError === true, empty: isEmptyResult(key, result) });
      } catch {
        // telemetry must never break a tool call
      }
      return result;
    } catch (err) {
      try {
        record(key, { error: true, empty: false });
      } catch {
        // as above
      }
      throw err;
    }
  });
}
