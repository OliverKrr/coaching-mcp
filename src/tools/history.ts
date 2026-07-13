// coaching-mcp/src/tools/history.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ChangeRow } from "../history.js";
import { toolText, withErrorHandling } from "../utils/errors.js";

const KINDS = ["section", "ref", "routine", "journal"] as const;

/**
 * Read-only window into the change history. Deliberately the ENTIRE MCP
 * surface over the `changes` table: recovery goes through the normal write
 * tools (re-applying lost content into the current document state), so this
 * module adds zero write surface. Purging history is a human-only action on
 * the account page.
 */
export function registerHistoryTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "list_changes",
    {
      description:
        "Change history: list recent edits, overwrites, and deletions of the user's stored " +
        "documents, newest first. Each entry records what the operation REMOVED, so content " +
        "lost by mistake can be found and recovered. Use when the user reports missing or " +
        "wrongly changed content. Recover via get_change, then re-apply the lost text into " +
        "the CURRENT document with edit_*/update_*/save_routine (deleted docs: recreate them).",
      inputSchema: {
        kind: z.enum(KINDS).optional().describe("Filter by document kind"),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("Filter to one document: section/reference/routine name, or journal entry id"),
        limit: z.number().int().min(1).max(100).optional().describe("Max entries (default 20)"),
      },
    },
    ({ kind, name, limit }) =>
      withErrorHandling("list_changes", () => {
        const where: string[] = [];
        const params: unknown[] = [];
        if (kind) {
          where.push("kind = ?");
          params.push(kind);
        }
        if (name) {
          where.push("name = ?");
          params.push(name);
        }
        const rows = db
          .prepare(
            `SELECT * FROM changes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
              " ORDER BY id DESC LIMIT ?",
          )
          .all(...params, limit ?? 20) as ChangeRow[];
        if (rows.length === 0) {
          return toolText(
            "No recorded changes" +
              (kind || name ? " matching the filter" : "") +
              ". History covers edits, overwrites, and deletions for a limited retention window.",
          );
        }
        const lines = rows.map((r) => {
          const removed = `${r.old_text.length} chars`;
          const detail =
            r.op === "edit"
              ? `removed ${removed}, inserted ${r.new_text?.length ?? 0} chars`
              : r.op === "delete"
                ? `document removed (${removed})`
                : `overwritten (diff of previous version, ${removed})`;
          return `- #${r.id} [${r.op}] ${r.kind} '${r.name}' — ${r.created_at} UTC — ${detail} — "${preview(r.old_text)}"`;
        });
        return toolText(
          `Recent changes, newest first (what each operation removed):\n${lines.join("\n")}\n\n` +
            "Inspect one with get_change(id); re-apply lost content via the normal write tools.",
        );
      }),
  );

  server.registerTool(
    "get_change",
    {
      description:
        "Get one change-history entry in full: the removed content (for edits also the " +
        "inserted content). Recovery is re-applying: graft the lost text into the CURRENT " +
        "document via edit_*/update_* — or recreate a deleted document from the recorded " +
        "content — rather than mechanically reverting.",
      inputSchema: {
        id: z.number().int().describe("Change id from list_changes"),
      },
    },
    ({ id }) =>
      withErrorHandling("get_change", () => {
        const row = db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as
          | ChangeRow
          | undefined;
        if (!row) {
          return toolText(`Change #${id} not found — it may have been pruned or purged.`);
        }
        const parts = [
          `# Change #${row.id} — ${row.op} ${row.kind} '${row.name}' (${row.created_at} UTC${row.source ? `, via ${row.source}` : ""})`,
        ];
        if (row.op === "edit") {
          parts.push(
            `## Removed text\n\n${row.old_text}`,
            `## Inserted text\n\n${row.new_text ?? ""}`,
            "To undo this edit: call the matching edit tool with old_string = the inserted " +
              "text and new_string = the removed text (works while the inserted text still " +
              "occurs exactly once in the current document).",
          );
        } else if (row.op === "replace") {
          parts.push(
            `## Diff of the previous version ('-' lines were removed, '+' lines were added)\n\n${row.old_text}`,
            "To recover: re-apply the '-' lines that should not have been lost into the " +
              "current document via the edit tools.",
          );
        } else {
          parts.push(
            `## Deleted content\n\n${row.old_text}`,
            "To restore: recreate the document from this content via the matching write tool " +
              "(sections/references: update_*; routines: save_routine — the first lines above " +
              "record its cadence and status; journal: append_journal).",
          );
        }
        return toolText(parts.join("\n\n"));
      }),
  );
}

function preview(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
