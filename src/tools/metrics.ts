import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Metric } from "../db.js";
import { checkWrite, ENTRY_MAX_BYTES, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

/**
 * Structured metrics: repeated numeric measurements (body weight, resting HR,
 * HRV baseline, adherence %, threshold pace in s/km, …) as rows instead of
 * markdown-table edits. Trends become a query; the documents stay prose.
 */

const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

export function registerMetricsTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  server.registerTool(
    "record_metric",
    {
      title: "Record metric",
      description:
        "Record one numeric measurement (body weight, resting HR, weekly adherence %, threshold pace in " +
        "seconds, …). Use a stable kebab-case name per series — trends only work when the name repeats. " +
        "Prefer this over editing markdown tables for anything measured more than once.",
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .describe("Series name, stable across measurements (e.g. 'body-weight', 'resting-hr')"),
        value: z.number().finite().describe("The numeric value"),
        unit: z
          .string()
          .max(32)
          .optional()
          .describe("Unit (e.g. 'kg', 'bpm', '%', 's/km') — keep it constant per series"),
        note: z.string().max(500).optional().describe("Optional context for this data point"),
        measured_at: z
          .string()
          .regex(DATE_OR_DATETIME)
          .optional()
          .describe("When it was measured (YYYY-MM-DD or 'YYYY-MM-DD HH:MM'); defaults to now"),
      },
    },
    ({ name, value, unit, note, measured_at }) =>
      withErrorHandling("record_metric", () => {
        const series = name.trim().toLowerCase();
        const bytes = series.length + (unit?.length ?? 0) + (note?.length ?? 0);
        const refused = checkWrite(db, limits, {
          docBytes: bytes,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: bytes,
        });
        if (refused) return toolError(refused);
        const last = db
          .prepare("SELECT unit FROM metrics WHERE name = ? ORDER BY id DESC LIMIT 1")
          .get(series) as { unit: string | null } | undefined;
        const result =
          measured_at !== undefined
            ? db
                .prepare(
                  "INSERT INTO metrics(name, value, unit, note, measured_at) VALUES (?, ?, ?, ?, ?)",
                )
                .run(series, value, unit ?? null, note ?? null, measured_at)
            : db
                .prepare("INSERT INTO metrics(name, value, unit, note) VALUES (?, ?, ?, ?)")
                .run(series, value, unit ?? null, note ?? null);
        let warning = "";
        if (last !== undefined && (last.unit ?? null) !== (unit ?? null)) {
          warning = ` ⚠ Unit differs from this series' previous entry ('${last.unit ?? "none"}' vs '${unit ?? "none"}') — mixed units break trends; delete_metric the wrong one.`;
        }
        return toolText(
          `Metric #${result.lastInsertRowid} recorded: ${series} = ${value}${unit ? ` ${unit}` : ""}.${warning}`,
        );
      }),
  );

  server.registerTool(
    "get_metrics",
    {
      title: "Get metrics",
      description:
        "Read recorded metrics. Without `name`: a summary of every series (count, span, latest value) — " +
        "use it to discover what is tracked. With `name`: that series' data points (newest first, with " +
        "min/max/avg over the selection), optionally bounded by since/until.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        name: z.string().optional().describe("Series name; omit to list all series"),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Only points measured on/after this date (YYYY-MM-DD)"),
        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Only points measured on/before this date (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max data points returned"),
      },
    },
    ({ name, since, until, limit }) =>
      withErrorHandling("get_metrics", () => {
        if (name === undefined) {
          const rows = db
            .prepare(
              `SELECT name, COUNT(*) AS n, MIN(measured_at) AS first, MAX(measured_at) AS last
							 FROM metrics GROUP BY name ORDER BY name`,
            )
            .all() as Array<{ name: string; n: number; first: string; last: string }>;
          if (rows.length === 0) {
            return toolText("No metrics recorded yet. Use record_metric to start a series.");
          }
          const latest = db.prepare(
            "SELECT value, unit FROM metrics WHERE name = ? ORDER BY measured_at DESC, id DESC LIMIT 1",
          );
          return toolText(
            "Tracked series:\n" +
              rows
                .map((r) => {
                  const l = latest.get(r.name) as { value: number; unit: string | null };
                  return `- **${r.name}**: ${r.n} point${r.n === 1 ? "" : "s"}, ${r.first.slice(0, 10)} → ${r.last.slice(0, 10)}, latest ${l.value}${l.unit ? ` ${l.unit}` : ""}`;
                })
                .join("\n"),
          );
        }
        const series = name.trim().toLowerCase();
        const clauses = ["name = ?"];
        const params: Array<string | number> = [series];
        if (since !== undefined) {
          clauses.push("measured_at >= ?");
          params.push(since);
        }
        if (until !== undefined) {
          // Date-only until must include that whole day's datetime rows.
          clauses.push("measured_at <= ?");
          params.push(`${until} 23:59:59`);
        }
        const where = clauses.join(" AND ");
        const stats = db
          .prepare(
            `SELECT COUNT(*) AS n, MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg FROM metrics WHERE ${where}`,
          )
          .get(...params) as { n: number; min: number; max: number; avg: number };
        if (stats.n === 0) {
          const known = db
            .prepare("SELECT DISTINCT name FROM metrics ORDER BY name")
            .all() as Array<{
            name: string;
          }>;
          return toolText(
            `No data points for '${series}'${since || until ? " in that range" : ""}. Known series: ${known.map((k) => k.name).join(", ") || "none"}`,
          );
        }
        const rows = db
          .prepare(
            `SELECT id, value, unit, note, measured_at FROM metrics WHERE ${where} ORDER BY measured_at DESC, id DESC LIMIT ?`,
          )
          .all(...params, limit) as Metric[];
        const unit = rows[0].unit ? ` ${rows[0].unit}` : "";
        const header =
          `**${series}** — ${stats.n} point${stats.n === 1 ? "" : "s"}` +
          (stats.n > 1
            ? `, min ${round(stats.min)} / avg ${round(stats.avg)} / max ${round(stats.max)}${unit}`
            : "") +
          (stats.n > rows.length ? ` (showing newest ${rows.length})` : "");
        return toolText(
          `${header}\n` +
            rows
              .map(
                (r) =>
                  `#${r.id} ${r.measured_at} · ${r.value}${r.unit ? ` ${r.unit}` : ""}${r.note ? ` — ${r.note}` : ""}`,
              )
              .join("\n"),
        );
      }),
  );

  server.registerTool(
    "delete_metric",
    {
      title: "Delete metric",
      description:
        "Delete one recorded data point (a mistyped value, a wrong-unit entry). Permanent — metrics are " +
        "not covered by change history.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: z.number().int().describe("The data point id (from get_metrics)"),
        confirm: z.literal(true).describe("Must be true to confirm deletion"),
      },
    },
    ({ id }) =>
      withErrorHandling("delete_metric", () => {
        const result = db.prepare("DELETE FROM metrics WHERE id = ?").run(id);
        return toolText(
          result.changes > 0 ? `Metric #${id} deleted.` : `No metric with id #${id}.`,
        );
      }),
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
