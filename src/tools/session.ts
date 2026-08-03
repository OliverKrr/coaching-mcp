import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JournalEntry, Section } from "../db.js";
import { usageWarning, type WriteLimits } from "../quota.js";
import { loadSeedUpdates, pendingUpdates } from "../seed-updates.js";
import { toolText, withErrorHandling } from "../utils/errors.js";
import { journalHeadline } from "../utils/journal.js";
import { openItemLine, openOpenItems } from "./openitems.js";

/**
 * Composite session start: everything the session-start protocol needs in one
 * round trip — coaching context, open items (with overdue markers), the latest
 * journal entries in full plus older ones as headlines, and the pending
 * seed-update notice. Headlines keep the payload bounded as the journal grows;
 * full history stays one get_journal / search_knowledge call away.
 */
export function registerSessionTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
  seedDir?: string,
): void {
  server.registerTool(
    "start_session",
    {
      title: "Start coaching session",
      description:
        "One-call session start: the full coaching context (SKILL.md) + open items (overdue marked) + " +
        "the most recent journal entries in full + older entries as headlines. Prefer this over separate " +
        "get_coaching_context / list_open_items / get_journal calls at the start of every session.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        journal_full: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(2)
          .describe("How many of the newest journal entries to include in full"),
        journal_headlines: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(10)
          .describe("How many older entries to include as one-line headlines"),
      },
    },
    ({ journal_full, journal_headlines }) =>
      withErrorHandling("start_session", () => {
        const warning = usageWarning(db, limits);
        const row = db.prepare("SELECT content FROM sections WHERE name = 'main'").get() as
          | Section
          | undefined;
        const context = row?.content ?? "No coaching context found. Database may not be seeded.";

        let notice = "";
        if (seedDir !== undefined) {
          const updates = loadSeedUpdates(seedDir);
          if (updates !== null) {
            const pending = pendingUpdates(db, updates).length;
            if (pending > 0) {
              notice = `\n\n⚠ Seed guidance updates pending (${pending}) — call get_seed_updates and merge them per their Apply level before continuing.`;
            }
          }
        }

        const items = openOpenItems(db);
        const overdueCount = items.filter((i) => i.overdue).length;
        const itemsHeader = `## Open items (${items.length} open${overdueCount > 0 ? `, ${overdueCount} OVERDUE` : ""})`;
        const itemsBlock =
          items.length === 0
            ? "No open items."
            : items.map((r) => openItemLine(r, false)).join("\n");

        const fullEntries = db
          .prepare("SELECT id, entry, created_at FROM journal ORDER BY id DESC LIMIT ?")
          .all(journal_full) as JournalEntry[];
        const headlineEntries = db
          .prepare("SELECT id, entry, created_at FROM journal ORDER BY id DESC LIMIT ? OFFSET ?")
          .all(journal_headlines, journal_full) as JournalEntry[];

        const parts = [warning.trim(), context + notice, "---", `${itemsHeader}\n\n${itemsBlock}`];
        if (fullEntries.length > 0) {
          parts.push(
            `## Journal — latest ${fullEntries.length === 1 ? "entry" : `${fullEntries.length} entries`} in full\n\n` +
              fullEntries.map((r) => `#${r.id} [${r.created_at}] ${r.entry}`).join("\n\n---\n\n"),
          );
        }
        if (headlineEntries.length > 0) {
          parts.push(
            "## Journal — earlier headlines (get_journal with ids for full text)\n\n" +
              headlineEntries.map(journalHeadline).join("\n"),
          );
        }
        if (fullEntries.length === 0 && headlineEntries.length === 0) {
          parts.push("## Journal\n\nNo journal entries yet.");
        }
        return toolText(parts.filter((p) => p.length > 0).join("\n\n"));
      }),
  );
}
