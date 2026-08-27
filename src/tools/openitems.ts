import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { OpenItem } from "../db.js";
import { checkWrite, ENTRY_MAX_BYTES, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

export type OpenItemWithOverdue = OpenItem & { overdue: number };

const OPEN_ITEM_COLUMNS =
  "id, kind, content, status, source, dedup_key, relevant_date, resolved_note, created_at, updated_at, " +
  "(status = 'open' AND relevant_date IS NOT NULL AND relevant_date < date('now')) AS overdue";

/** All currently open items, newest first — shared with start_session. */
export function openOpenItems(db: Database.Database): OpenItemWithOverdue[] {
  return db
    .prepare(`SELECT ${OPEN_ITEM_COLUMNS} FROM open_items WHERE status = 'open' ORDER BY id DESC`)
    .all() as OpenItemWithOverdue[];
}

/**
 * One-line rendering of an open item — shared with start_session. `maxChars`
 * caps the body (session starts must stay readable even when an item carries
 * a long body); the marker names the recovery call, so nothing is hidden.
 */
export function openItemLine(r: OpenItemWithOverdue, withStatus: boolean, maxChars = 0): string {
  const label = withStatus ? `${r.kind}, ${r.status}` : r.kind;
  const dates =
    `opened ${r.created_at.slice(0, 10)}` +
    (r.relevant_date ? `, for ${r.relevant_date}` : "") +
    (r.overdue ? " — OVERDUE" : "");
  const content =
    maxChars > 0 && r.content.length > maxChars
      ? `${r.content.slice(0, maxChars)}… (+${r.content.length - maxChars} chars — list_open_items has the full text)`
      : r.content;
  return (
    `#${r.id} [${label}] (${dates}) ${content}` +
    (r.resolved_note ? `  — resolved: ${r.resolved_note}` : "") +
    (r.source ? `  — src: ${r.source}` : "")
  );
}

export function registerOpenItemsTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  server.registerTool(
    "add_open_item",
    {
      title: "Add open item",
      description:
        "Record a coaching commitment (the user's if-then next action) or a flag (something to surface). " +
        "Set `dedup_key` for flags so a recurring condition isn't raised twice — if an OPEN item with that " +
        "key exists, this is a no-op and returns the existing id. Call at session close (commitments) or " +
        "from routines (flags).",
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: {
        kind: z.enum(["commitment", "flag"]),
        content: z.string().min(1).describe("The commitment or flag text"),
        source: z
          .string()
          .optional()
          .describe("Provenance: 'session' | 'weekly-review' | 'event-flag'"),
        dedup_key: z
          .string()
          .optional()
          .describe(
            "Stable key for a recurring condition (flags). No-op if an open item with it exists.",
          ),
        relevant_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "ISO date the item targets (session a commitment is for / day a flag is about)",
          ),
      },
    },
    ({ kind, content, source, dedup_key, relevant_date }) =>
      withErrorHandling("add_open_item", () => {
        const refused = checkWrite(db, limits, {
          docBytes: content.length,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: content.length,
        });
        if (refused) return toolError(refused);
        if (dedup_key !== undefined) {
          const existing = db
            .prepare("SELECT id FROM open_items WHERE dedup_key = ? AND status = 'open'")
            .get(dedup_key) as { id: number } | undefined;
          if (existing) {
            return toolText(`Open item #${existing.id} already open (dedup on '${dedup_key}').`);
          }
        }
        const result = db
          .prepare(
            "INSERT INTO open_items(kind, content, source, dedup_key, relevant_date) VALUES (?, ?, ?, ?, ?)",
          )
          .run(kind, content, source ?? null, dedup_key ?? null, relevant_date ?? null);
        return toolText(`Open item #${result.lastInsertRowid} added (${kind}).`);
      }),
  );

  server.registerTool(
    "list_open_items",
    {
      title: "List open items",
      description:
        "List open coaching items (commitments + flags). Call at session start to surface what needs " +
        "attention and what to follow up on. Defaults to status='open'; 'all' includes resolved items. " +
        "Items whose relevant_date has passed are marked OVERDUE — follow up or renegotiate those first. " +
        "`format: 'headlines'` returns one compact line per item (body truncated) for cheap scans of " +
        "large histories.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        kind: z
          .enum(["commitment", "flag"])
          .optional()
          .describe("Filter to one kind. Omit for both."),
        status: z
          .enum(["open", "done", "dismissed", "all"])
          .default("open")
          .describe("Filter by status. Defaults to 'open'; 'all' returns every status."),
        format: z
          .enum(["full", "headlines"])
          .default("full")
          .describe("'headlines' truncates each item's body to its first ~120 chars"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe("Max items returned, newest first — a note tells you when more matched"),
      },
    },
    ({ kind, status, format, limit }) =>
      withErrorHandling("list_open_items", () => {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (status !== "all") {
          clauses.push("status = ?");
          params.push(status);
        }
        if (kind !== undefined) {
          clauses.push("kind = ?");
          params.push(kind);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const total = (
          db.prepare(`SELECT COUNT(*) AS n FROM open_items ${where}`).get(...params) as {
            n: number;
          }
        ).n;
        const rows = db
          .prepare(`SELECT ${OPEN_ITEM_COLUMNS} FROM open_items ${where} ORDER BY id DESC LIMIT ?`)
          .all(...params, limit) as OpenItemWithOverdue[];
        if (rows.length === 0) {
          return toolText(`No ${status} open items${kind ? ` of kind '${kind}'` : ""}.`);
        }
        const prefix =
          total > rows.length
            ? `Note: showing the newest ${rows.length} of ${total} matching items — raise limit or narrow the filter for the rest.\n\n`
            : "";
        const maxChars = format === "headlines" ? 120 : 0;
        return toolText(
          prefix + rows.map((r) => openItemLine(r, status !== "open", maxChars)).join("\n"),
        );
      }),
  );

  server.registerTool(
    "resolve_open_item",
    {
      title: "Resolve open item",
      description:
        "Close a coaching open item once it's been acted on or no longer applies. Use 'done' when handled, " +
        "'dismissed' when dropped. The optional note is stored alongside the item — the original content " +
        "is preserved verbatim.",
      inputSchema: {
        id: z.number().int().describe("The open item id"),
        status: z.enum(["done", "dismissed"]).describe("'done' (handled) or 'dismissed' (dropped)"),
        note: z.string().optional().describe("Optional resolution note stored with the item"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ id, status, note }) =>
      withErrorHandling("resolve_open_item", () => {
        const row = db.prepare("SELECT id FROM open_items WHERE id = ?").get(id) as
          | { id: number }
          | undefined;
        if (!row) return toolText(`Open item #${id} not found.`);
        const refused = checkWrite(db, limits, {
          docBytes: note?.length ?? 0,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: 0,
        });
        if (refused) return toolError(refused);
        db.prepare(
          "UPDATE open_items SET status = ?, resolved_note = COALESCE(?, resolved_note), updated_at = datetime('now') WHERE id = ?",
        ).run(status, note ?? null, id);
        return toolText(`Open item #${id} marked ${status}.`);
      }),
  );
}
