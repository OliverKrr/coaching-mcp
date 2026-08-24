import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Metric, MetricSeries } from "../db.js";
import { checkWrite, ENTRY_MAX_BYTES, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

/**
 * Structured metrics: repeated numeric measurements (body weight, resting HR,
 * HRV baseline, adherence %, threshold pace in s/km, …) as rows instead of
 * markdown-table edits. Trends become a query; the documents stay prose.
 *
 * Series come in two kinds, set once on first use, because the two must never
 * be conflated: a 'state' series holds conflicting claims about the present
 * ("FTP is 265 W" must CLOSE "FTP is 250 W"), so a new value supersedes the
 * previous one via validity windows and reads return only what is currently
 * true unless asked for history; an 'event' series holds additive facts
 * ("ran 62 km this week" must never close last week's 66 km), so nothing ever
 * supersedes and every counting question keeps working. In a plain append log
 * the old and new value of a changed fact compete at read time — the window is
 * a schema property that resolves that without any reader-side reasoning.
 */

const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

function getSeries(db: Database.Database, name: string): MetricSeries | undefined {
  return db.prepare("SELECT * FROM metric_series WHERE name = ?").get(name) as
    | MetricSeries
    | undefined;
}

/**
 * Recompute every validity window of one series: each row is valid until the
 * earliest strictly-later row (ties on measured_at broken by id). Idempotent
 * and self-healing — running it after any insert, backfill or delete yields
 * exactly one open row, the same recompute-over-increment spirit as
 * recomputeContentBytes.
 */
function rebuildValidityWindows(db: Database.Database, series: string): void {
  db.prepare(
    `UPDATE metrics SET valid_to = (
			SELECT MIN(m2.measured_at) FROM metrics m2
			WHERE m2.name = metrics.name
				AND (m2.measured_at > metrics.measured_at
					OR (m2.measured_at = metrics.measured_at AND m2.id > metrics.id))
		) WHERE name = ?`,
  ).run(series);
}

export type StaleMetric = {
  name: string;
  value: number;
  unit: string | null;
  measured_at: string;
  stale_after_days: number;
};

/** Current 'state' values past their staleness window — surfaced at session start. */
export function staleStateMetrics(db: Database.Database): StaleMetric[] {
  return db
    .prepare(
      `SELECT s.name AS name, m.value AS value, m.unit AS unit, m.measured_at AS measured_at,
				s.stale_after_days AS stale_after_days
			FROM metric_series s JOIN metrics m ON m.name = s.name AND m.valid_to IS NULL
			WHERE s.kind = 'state' AND s.stale_after_days IS NOT NULL
				AND julianday('now') - julianday(m.measured_at) > s.stale_after_days
			ORDER BY s.name`,
    )
    .all() as StaleMetric[];
}

/** One-line session-start flag, or "" when nothing is stale. */
export function staleMetricsLine(db: Database.Database): string {
  const stale = staleStateMetrics(db);
  if (stale.length === 0) return "";
  const parts = stale.map(
    (s) =>
      `${s.name} = ${s.value}${s.unit ? ` ${s.unit}` : ""} (recorded ${s.measured_at.slice(0, 10)}, staleness ${s.stale_after_days} d)`,
  );
  return `⚠ Stale state metrics: ${parts.join("; ")} — remeasure or re-record.`;
}

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
        "Prefer this over editing markdown tables for anything measured more than once. Series kinds: " +
        "'state' = the new value supersedes the previous one (FTP, thresholds, baselines — the current " +
        "value is what's true now); 'event' = values accumulate (weekly volume, adherence — nothing ever " +
        "supersedes). Kind is set on a series' first recording and fixed after that.",
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
        series_kind: z
          .enum(["state", "event"])
          .optional()
          .describe(
            "Set on the series' FIRST recording: 'state' supersedes (what's true now), 'event' " +
              "accumulates (countable history). Default 'event'. Fixed once set.",
          ),
        stale_after_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe(
            "For 'state' series: flag the current value at session start once it is older than this " +
              "many days (e.g. 180 for an FTP retest). May be set or changed on any recording.",
          ),
      },
    },
    ({ name, value, unit, note, measured_at, series_kind, stale_after_days }) =>
      withErrorHandling("record_metric", () => {
        const series = name.trim().toLowerCase();
        const bytes = series.length + (unit?.length ?? 0) + (note?.length ?? 0);
        const refused = checkWrite(db, limits, {
          docBytes: bytes,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: bytes,
        });
        if (refused) return toolError(refused);
        const existing = getSeries(db, series);
        if (existing && series_kind !== undefined && series_kind !== existing.kind) {
          return toolError(
            `series '${series}' is a '${existing.kind}' series — the kind is fixed once set. ` +
              "Record without series_kind, or start a differently-named series.",
          );
        }
        const kind = existing?.kind ?? series_kind ?? "event";
        const last = db
          .prepare("SELECT unit FROM metrics WHERE name = ? ORDER BY id DESC LIMIT 1")
          .get(series) as { unit: string | null } | undefined;

        const write = db.transaction(() => {
          if (!existing) {
            db.prepare(
              "INSERT INTO metric_series(name, kind, stale_after_days) VALUES (?, ?, ?)",
            ).run(series, kind, stale_after_days ?? null);
          } else if (stale_after_days !== undefined) {
            db.prepare("UPDATE metric_series SET stale_after_days = ? WHERE name = ?").run(
              stale_after_days,
              series,
            );
          }
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
          if (kind === "state") rebuildValidityWindows(db, series);
          return Number(result.lastInsertRowid);
        });
        const id = write();

        let supersession = "";
        if (kind === "state") {
          const inserted = db.prepare("SELECT valid_to FROM metrics WHERE id = ?").get(id) as Pick<
            Metric,
            "valid_to"
          >;
          if (inserted.valid_to !== null) {
            supersession = ` Recorded as historical — a newer value has been valid since ${inserted.valid_to}.`;
          } else {
            const previous = db
              .prepare(
                `SELECT id, value, unit, measured_at FROM metrics
								WHERE name = ? AND id != ? AND valid_to IS NOT NULL
								ORDER BY measured_at DESC, id DESC LIMIT 1`,
              )
              .get(series, id) as Metric | undefined;
            supersession = previous
              ? ` Supersedes #${previous.id} (${previous.value}${previous.unit ? ` ${previous.unit}` : ""}, valid since ${previous.measured_at.slice(0, 10)}).`
              : existing
                ? ""
                : " New state series — each new value supersedes the previous one.";
          }
        }

        let warning = "";
        if (last !== undefined && (last.unit ?? null) !== (unit ?? null)) {
          warning = ` ⚠ Unit differs from this series' previous entry ('${last.unit ?? "none"}' vs '${unit ?? "none"}') — mixed units break trends; delete_metric the wrong one.`;
        }
        return toolText(
          `Metric #${id} recorded: ${series} = ${value}${unit ? ` ${unit}` : ""}.${supersession}${warning}`,
        );
      }),
  );

  server.registerTool(
    "get_metrics",
    {
      title: "Get metrics",
      description:
        "Read recorded metrics. Without `name`: a summary of every series (kind, count, span, current/" +
        "latest value, staleness) — use it to discover what is tracked. With `name`: for a 'state' " +
        "series the currently-valid value (use `as_of` for 'what was it then?', `include_superseded` " +
        "for the full trail); for an 'event' series the data points (newest first, with min/max/avg), " +
        "optionally bounded by since/until.",
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
        as_of: z
          .string()
          .regex(DATE_OR_DATETIME)
          .optional()
          .describe(
            "For 'state' series: return the value that was valid at this moment " +
              "(answers 'what was my FTP in June?')",
          ),
        include_superseded: z
          .boolean()
          .default(false)
          .describe("For 'state' series: include superseded values with their validity windows"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max data points returned"),
      },
    },
    ({ name, since, until, as_of, include_superseded, limit }) =>
      withErrorHandling("get_metrics", () => {
        if (name === undefined) return toolText(seriesOverview(db));

        const series = name.trim().toLowerCase();
        const kind = getSeries(db, series)?.kind ?? "event";
        // A date-only as_of means "by the end of that day".
        const asOf = as_of !== undefined && as_of.length === 10 ? `${as_of} 23:59:59` : as_of;

        if (kind === "state" && asOf !== undefined) {
          const row = db
            .prepare(
              `SELECT id, value, unit, note, measured_at, valid_to FROM metrics
							WHERE name = ? AND measured_at <= ? AND (valid_to IS NULL OR valid_to > ?)
							ORDER BY measured_at DESC, id DESC LIMIT 1`,
            )
            .get(series, asOf, asOf) as Metric | undefined;
          if (!row) {
            const first = db
              .prepare("SELECT MIN(measured_at) AS m FROM metrics WHERE name = ?")
              .get(series) as { m: string | null };
            return toolText(
              `No value of '${series}' was valid at ${as_of}.` +
                (first.m ? ` The series starts ${first.m.slice(0, 10)}.` : " Unknown series."),
            );
          }
          return toolText(
            `**${series}** as of ${as_of}: ${row.value}${row.unit ? ` ${row.unit}` : ""} ` +
              `(#${row.id}, valid ${row.measured_at.slice(0, 10)} → ${row.valid_to ? row.valid_to.slice(0, 10) : "current"})${row.note ? ` — ${row.note}` : ""}`,
          );
        }

        if (kind === "state" && !include_superseded) {
          const current = db
            .prepare(
              `SELECT id, value, unit, note, measured_at FROM metrics
							WHERE name = ? AND valid_to IS NULL ORDER BY measured_at DESC, id DESC LIMIT 1`,
            )
            .get(series) as Metric | undefined;
          if (!current) return toolText(unknownSeries(db, series, since, until));
          const superseded = (
            db
              .prepare("SELECT COUNT(*) AS n FROM metrics WHERE name = ? AND valid_to IS NOT NULL")
              .get(series) as { n: number }
          ).n;
          return toolText(
            `**${series}** (state): ${current.value}${current.unit ? ` ${current.unit}` : ""} — current since ${current.measured_at.slice(0, 10)} (#${current.id})${current.note ? ` — ${current.note}` : ""}` +
              (superseded > 0
                ? `\n${superseded} superseded value${superseded === 1 ? "" : "s"} — include_superseded: true for the history, as_of for a point in time.`
                : ""),
          );
        }

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
        if (stats.n === 0) return toolText(unknownSeries(db, series, since, until));
        const rows = db
          .prepare(
            `SELECT id, value, unit, note, measured_at, valid_to FROM metrics WHERE ${where} ORDER BY measured_at DESC, id DESC LIMIT ?`,
          )
          .all(...params, limit) as Metric[];
        const unit = rows[0].unit ? ` ${rows[0].unit}` : "";
        const header =
          `**${series}**${kind === "state" ? " (state, full history)" : ""} — ${stats.n} point${stats.n === 1 ? "" : "s"}` +
          (stats.n > 1
            ? `, min ${round(stats.min)} / avg ${round(stats.avg)} / max ${round(stats.max)}${unit}`
            : "") +
          (stats.n > rows.length ? ` (showing newest ${rows.length})` : "");
        return toolText(
          `${header}\n` +
            rows
              .map((r) => {
                const window =
                  kind === "state"
                    ? ` [${r.measured_at.slice(0, 10)} → ${r.valid_to ? r.valid_to.slice(0, 10) : "current"}]`
                    : "";
                return `#${r.id} ${r.measured_at} · ${r.value}${r.unit ? ` ${r.unit}` : ""}${window}${r.note ? ` — ${r.note}` : ""}`;
              })
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
        "not covered by change history. On a 'state' series the validity windows re-close around the gap.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: z.number().int().describe("The data point id (from get_metrics)"),
        confirm: z.literal(true).describe("Must be true to confirm deletion"),
      },
    },
    ({ id }) =>
      withErrorHandling("delete_metric", () => {
        const row = db.prepare("SELECT name FROM metrics WHERE id = ?").get(id) as
          | { name: string }
          | undefined;
        if (!row) return toolText(`No metric with id #${id}.`);
        const remove = db.transaction(() => {
          db.prepare("DELETE FROM metrics WHERE id = ?").run(id);
          if (getSeries(db, row.name)?.kind === "state") rebuildValidityWindows(db, row.name);
        });
        remove();
        return toolText(`Metric #${id} deleted.`);
      }),
  );
}

function seriesOverview(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT m.name AS name, COUNT(*) AS n, MIN(m.measured_at) AS first, MAX(m.measured_at) AS last,
				COALESCE(s.kind, 'event') AS kind, s.stale_after_days AS stale_after_days
			FROM metrics m LEFT JOIN metric_series s ON s.name = m.name
			GROUP BY m.name ORDER BY m.name`,
    )
    .all() as Array<{
    name: string;
    n: number;
    first: string;
    last: string;
    kind: "state" | "event";
    stale_after_days: number | null;
  }>;
  if (rows.length === 0) {
    return "No metrics recorded yet. Use record_metric to start a series.";
  }
  const latest = db.prepare(
    `SELECT value, unit, measured_at, (julianday('now') - julianday(measured_at)) AS age_days
		FROM metrics WHERE name = ? AND (valid_to IS NULL OR ? = 'event')
		ORDER BY measured_at DESC, id DESC LIMIT 1`,
  );
  return (
    "Tracked series:\n" +
    rows
      .map((r) => {
        const l = latest.get(r.name, r.kind) as {
          value: number;
          unit: string | null;
          measured_at: string;
          age_days: number;
        };
        const label = r.kind === "state" ? "current" : "latest";
        const stale =
          r.kind === "state" && r.stale_after_days !== null && l.age_days > r.stale_after_days
            ? ` ⚠ stale (recorded ${l.measured_at.slice(0, 10)}, staleness ${r.stale_after_days} d)`
            : "";
        return `- **${r.name}** [${r.kind}]: ${r.n} point${r.n === 1 ? "" : "s"}, ${r.first.slice(0, 10)} → ${r.last.slice(0, 10)}, ${label} ${l.value}${l.unit ? ` ${l.unit}` : ""}${stale}`;
      })
      .join("\n")
  );
}

function unknownSeries(
  db: Database.Database,
  series: string,
  since?: string,
  until?: string,
): string {
  const known = db.prepare("SELECT DISTINCT name FROM metrics ORDER BY name").all() as Array<{
    name: string;
  }>;
  return `No data points for '${series}'${since || until ? " in that range" : ""}. Known series: ${known.map((k) => k.name).join(", ") || "none"}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
