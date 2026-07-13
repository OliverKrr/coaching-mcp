// coaching-mcp/src/tools/edit.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { type ChangeKind, logEdit } from "../history.js";
import { checkWrite, DOC_MAX_BYTES, usageWarning, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

/**
 * Exact-string replacement edits — the safe default for changing existing
 * documents: only the quoted passage can change, so a truncated or paraphrased
 * regeneration of the rest of the document is structurally impossible. The
 * exact-once match also acts as an implicit concurrency check: if the content
 * changed since it was read, old_string no longer matches and the edit fails
 * loudly instead of clobbering. Matching is exact — no fuzzing, no trimming —
 * because a fuzzy match is a silently wrong edit.
 */
export function registerEditTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  registerEditTool(server, db, limits, {
    tool: "edit_section",
    title: "Edit section",
    table: "sections",
    kind: "section",
    label: "section",
    deleteTool: "delete_section",
    description:
      "Replace an exact text passage inside a knowledge section — the preferred way to change " +
      "existing content (only the quoted passage changes; the rest of the document cannot be " +
      "touched). Copy old_string verbatim from the current content, including whitespace and " +
      "line breaks; it must occur exactly once unless replace_all is set. Use update_section " +
      "only to create a section or for a deliberate full rewrite.",
  });
  registerEditTool(server, db, limits, {
    tool: "edit_reference",
    title: "Edit reference",
    table: "refs",
    kind: "ref",
    label: "reference",
    deleteTool: "delete_reference",
    description:
      "Replace an exact text passage inside a reference document — the preferred way to change " +
      "existing content (only the quoted passage changes; the rest of the document cannot be " +
      "touched). Copy old_string verbatim from the current content, including whitespace and " +
      "line breaks; it must occur exactly once unless replace_all is set. Use update_reference " +
      "only to create a reference or for a deliberate full rewrite.",
  });
}

function registerEditTool(
  server: McpServer,
  db: Database.Database,
  limits: WriteLimits | undefined,
  cfg: {
    tool: string;
    title: string;
    table: "sections" | "refs";
    kind: ChangeKind;
    label: string;
    deleteTool: string;
    description: string;
  },
): void {
  server.registerTool(
    cfg.tool,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(`${cfg.label[0].toUpperCase()}${cfg.label.slice(1)} name`),
        old_string: z
          .string()
          .min(1)
          .describe(
            "Exact existing text to replace — copied verbatim from the current document, " +
              "including whitespace and line breaks",
          ),
        new_string: z.string().describe("Replacement text; an empty string removes the passage"),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "Replace every occurrence when old_string appears more than once (default false)",
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ name, old_string, new_string, replace_all }) =>
      withErrorHandling(cfg.tool, () => {
        const row = db.prepare(`SELECT content FROM ${cfg.table} WHERE name = ?`).get(name) as
          | { content: string }
          | undefined;
        if (!row) {
          return toolText(`${capitalize(cfg.label)} '${name}' not found.`);
        }
        if (old_string === new_string) {
          return toolError("old_string and new_string are identical — nothing would change.");
        }
        const occurrences = row.content.split(old_string).length - 1;
        if (occurrences === 0) {
          return toolError(
            `old_string not found in ${cfg.label} '${name}'. Re-read the document (its ` +
              "content may have changed since you last saw it) and retry with the exact current text.",
          );
        }
        if (occurrences > 1 && !replace_all) {
          return toolError(
            `old_string occurs ${occurrences} times in ${cfg.label} '${name}'. Include more ` +
              "surrounding context to make it unique, or set replace_all=true to replace every occurrence.",
          );
        }
        const next = row.content.split(old_string).join(new_string);
        if (next.trim() === "") {
          return toolError(
            `this edit would empty ${cfg.label} '${name}' — to remove the whole document use ` +
              `${cfg.deleteTool} (confirm=true) instead.`,
          );
        }
        const refused = checkWrite(db, limits, {
          docBytes: next.length,
          docMax: DOC_MAX_BYTES,
          deltaBytes: next.length - row.content.length,
        });
        if (refused) return toolError(refused);
        db.transaction(() => {
          db.prepare(
            `UPDATE ${cfg.table} SET content = ?, updated_at = datetime('now') WHERE name = ?`,
          ).run(next, name);
          logEdit(db, cfg.kind, name, old_string, new_string, "mcp");
        })();
        const what = occurrences > 1 ? `${occurrences} occurrences replaced` : "1 passage replaced";
        return toolText(
          `${capitalize(cfg.label)} '${name}' updated (${what}).${usageWarning(db, limits)}`,
        );
      }),
  );
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
