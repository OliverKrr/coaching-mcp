import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { OpenItem } from "../db.js";
import { checkWrite, ENTRY_MAX_BYTES, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

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
        "attention and what to follow up on. Defaults to status='open'.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        kind: z
          .enum(["commitment", "flag"])
          .optional()
          .describe("Filter to one kind. Omit for both."),
        status: z
          .enum(["open", "done", "dismissed"])
          .default("open")
          .describe("Filter by status. Defaults to 'open'."),
      },
    },
    ({ kind, status }) =>
      withErrorHandling("list_open_items", () => {
        const clauses = ["status = ?"];
        const params: string[] = [status];
        if (kind !== undefined) {
          clauses.push("kind = ?");
          params.push(kind);
        }
        const rows = db
          .prepare(
            "SELECT id, kind, content, status, source, dedup_key, relevant_date, created_at, updated_at " +
              `FROM open_items WHERE ${clauses.join(" AND ")} ORDER BY id DESC`,
          )
          .all(...params) as OpenItem[];
        if (rows.length === 0) {
          return toolText(`No ${status} open items${kind ? ` of kind '${kind}'` : ""}.`);
        }
        return toolText(
          rows
            .map(
              (r) =>
                `#${r.id} [${r.kind}]${r.relevant_date ? ` (${r.relevant_date})` : ""} ${r.content}` +
                (r.source ? `  — src: ${r.source}` : ""),
            )
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "resolve_open_item",
    {
      title: "Resolve open item",
      description:
        "Close a coaching open item once it's been acted on or no longer applies. Use 'done' when handled, " +
        "'dismissed' when dropped. Optional note is appended to the item.",
      inputSchema: {
        id: z.number().int().describe("The open item id"),
        status: z.enum(["done", "dismissed"]).describe("'done' (handled) or 'dismissed' (dropped)"),
        note: z.string().optional().describe("Optional note appended to the item content"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ id, status, note }) =>
      withErrorHandling("resolve_open_item", () => {
        const row = db.prepare("SELECT content FROM open_items WHERE id = ?").get(id) as
          | { content: string }
          | undefined;
        if (!row) return toolText(`Open item #${id} not found.`);
        const newContent = note ? `${row.content} — resolved: ${note}` : row.content;
        const refused = checkWrite(db, limits, {
          docBytes: newContent.length,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: newContent.length - row.content.length,
        });
        if (refused) return toolError(refused);
        db.prepare(
          "UPDATE open_items SET status = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(status, newContent, id);
        return toolText(`Open item #${id} marked ${status}.`);
      }),
  );
}
