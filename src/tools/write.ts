import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { logEdit, logReplace } from "../history.js";
import {
  checkWrite,
  DOC_MAX_BYTES,
  ENTRY_MAX_BYTES,
  usageWarning,
  type WriteLimits,
} from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

export function registerWriteTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  const existingContent = (table: "sections" | "refs", name: string): string | undefined =>
    (
      db.prepare(`SELECT content FROM ${table} WHERE name = ?`).get(name) as
        | { content: string }
        | undefined
    )?.content;

  server.registerTool(
    "update_section",
    {
      title: "Create or rewrite section",
      description:
        "Create a coaching knowledge section or fully rewrite one (the content replaces the " +
        "whole document). Use 'main' for the primary SKILL.md content. For targeted changes " +
        "to an existing section prefer edit_section — it only touches the passage you quote.",
      inputSchema: {
        name: z.string().min(1).describe("Section name — use 'main' for SKILL.md"),
        content: z.string().min(1).describe("Full replacement content"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ name, content }) =>
      withErrorHandling("update_section", () => {
        const existing = existingContent("sections", name);
        const refused = checkWrite(db, limits, {
          docBytes: content.length,
          docMax: DOC_MAX_BYTES,
          deltaBytes: content.length - (existing?.length ?? 0),
        });
        if (refused) return toolError(refused);
        db.transaction(() => {
          db.prepare(
            "INSERT INTO sections(name, content) VALUES (?, ?)" +
              " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
          ).run(name, content);
          if (existing !== undefined) logReplace(db, "section", name, existing, content, "mcp");
        })();
        return toolText(`Section '${name}' updated.${usageWarning(db, limits)}`);
      }),
  );

  server.registerTool(
    "update_reference",
    {
      title: "Create or rewrite reference",
      description:
        "Create a coaching reference document or fully rewrite one (the content replaces the " +
        "whole document) — core ones like patterns/lifestyle, or topic references like zones " +
        "or recipes. For targeted changes to an existing reference prefer edit_reference — it " +
        "only touches the passage you quote.",
      inputSchema: {
        name: z.string().min(1).describe("Reference name without .md extension"),
        content: z.string().min(1).describe("Full replacement content"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ name, content }) =>
      withErrorHandling("update_reference", () => {
        const existing = existingContent("refs", name);
        const refused = checkWrite(db, limits, {
          docBytes: content.length,
          docMax: DOC_MAX_BYTES,
          deltaBytes: content.length - (existing?.length ?? 0),
        });
        if (refused) return toolError(refused);
        db.transaction(() => {
          db.prepare(
            "INSERT INTO refs(name, content) VALUES (?, ?)" +
              " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
          ).run(name, content);
          if (existing !== undefined) logReplace(db, "ref", name, existing, content, "mcp");
        })();
        return toolText(`Reference '${name}' updated.${usageWarning(db, limits)}`);
      }),
  );

  server.registerTool(
    "append_journal",
    {
      title: "Append journal entry",
      description:
        "Append a coaching journal entry. The server records the timestamp automatically — do NOT prepend a date to the entry text. Call at the end of every coaching session to log decisions made, data changed, and observations.",
      inputSchema: {
        entry: z.string().min(1).describe("Journal entry text"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ entry }) =>
      withErrorHandling("append_journal", () => {
        const refused = checkWrite(db, limits, {
          docBytes: entry.length,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: entry.length,
        });
        if (refused) return toolError(refused);
        const result = db.prepare("INSERT INTO journal(entry) VALUES (?)").run(entry);
        return toolText(
          `Journal entry #${result.lastInsertRowid} saved.${usageWarning(db, limits)}`,
        );
      }),
  );

  server.registerTool(
    "correct_journal",
    {
      title: "Correct a journal entry",
      description:
        "Attach a correction to an existing journal entry when a later session establishes that it " +
        "stated something wrong. The original text is never changed or deleted — but every path that " +
        "returns the entry (get_journal, start_session, search_knowledge) now returns the correction " +
        "with it, so the wrong statement can no longer be read as true. Use this instead of appending " +
        "a new entry saying an older one was wrong: a reader would have to find that entry first. " +
        "State what is actually true, not just that the entry is wrong. Correcting an already " +
        "corrected entry appends to the correction; nothing is overwritten.",
      inputSchema: {
        entry_id: z.number().int().describe("Id of the journal entry to correct (the #N in reads)"),
        correction: z
          .string()
          .min(1)
          .describe("What is actually true — short, self-contained, in the person's language"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ entry_id, correction }) =>
      withErrorHandling("correct_journal", () => {
        const row = db
          .prepare("SELECT entry, correction FROM journal WHERE id = ?")
          .get(entry_id) as { entry: string; correction: string | null } | undefined;
        if (!row) return toolError(`No journal entry #${entry_id}.`);
        const previous = row.correction;
        const next = previous === null ? correction : `${previous}\n${correction}`;
        const refused = checkWrite(db, limits, {
          docBytes: row.entry.length + next.length,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: next.length - (previous?.length ?? 0),
        });
        if (refused) return toolError(refused);
        db.transaction(() => {
          db.prepare(
            "UPDATE journal SET correction = ?, corrected_at = datetime('now') WHERE id = ?",
          ).run(next, entry_id);
          logEdit(db, "journal", String(entry_id), previous ?? "", next, "mcp");
        })();
        const kept = previous === null ? "" : " The earlier correction was kept above it.";
        return toolText(
          `Correction attached to journal entry #${entry_id}. The original text is unchanged; ` +
            `every read of #${entry_id} now carries the correction.${kept}${usageWarning(db, limits)}`,
        );
      }),
  );

  server.registerTool(
    "archive_journal",
    {
      title: "Archive journal entries",
      description:
        "Mark journal entries as archived (or lift it again with archived: false). Archiving is the " +
        "growth control, not a deletion: an archived entry stays in the database, stays fully " +
        "findable via search_knowledge, and still comes back in full from get_journal with `ids` — " +
        "it is only no longer inlined in full at session start, where it would otherwise be paid for " +
        "on every run. Archive a period once its substance has been condensed into a reference " +
        "document, so the condensed version is what every session reads.",
      inputSchema: {
        ids: z
          .array(z.number().int())
          .min(1)
          .max(50)
          .describe("Journal entry ids to archive (the #N in reads)"),
        archived: z
          .boolean()
          .default(true)
          .describe("false lifts the flag again, restoring full inlining"),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ ids, archived }) =>
      withErrorHandling("archive_journal", () => {
        const placeholders = ids.map(() => "?").join(",");
        const existing = (
          db.prepare(`SELECT id FROM journal WHERE id IN (${placeholders})`).all(...ids) as Array<{
            id: number;
          }>
        ).map((r) => r.id);
        const missing = ids.filter((id) => !existing.includes(id));
        if (existing.length > 0) {
          db.prepare(
            `UPDATE journal SET archived_at = ${archived ? "datetime('now')" : "NULL"}` +
              ` WHERE id IN (${existing.map(() => "?").join(",")})`,
          ).run(...existing);
        }
        const verb = archived ? "archived" : "un-archived";
        const note =
          missing.length > 0
            ? ` No entry with id ${missing.map((id) => `#${id}`).join(", ")}.`
            : "";
        if (existing.length === 0) return toolText(`Nothing ${verb}.${note}`);
        return toolText(
          `${existing.length} journal ${existing.length === 1 ? "entry" : "entries"} ${verb} ` +
            `(${existing.map((id) => `#${id}`).join(", ")}). Full text stays available via ` +
            `get_journal with ids, and search_knowledge is unaffected.${note}`,
        );
      }),
  );
}
