import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JournalEntry, Section } from "../db.js";
import { formatBytes, indexBudgetLine, usageWarning, type WriteLimits } from "../quota.js";
import { loadSeedUpdates, pendingUpdates } from "../seed-updates.js";
import { toolText, withErrorHandling } from "../utils/errors.js";
import { JOURNAL_COLUMNS, journalHeadline, journalListed } from "../utils/journal.js";

/**
 * Per-entry body cap for the inlined journal slice. Session start is a fixed
 * per-session cost paid by every client and every scheduled run, so no single
 * entry may set it: one 12 KB debrief would otherwise spill the whole payload
 * to a file. 1200 chars is a full session entry (headline + decided/learned/
 * committed/watch-for); the marker names get_journal for the rest.
 */
const JOURNAL_INLINE_MAX = 1200;
import { staleMetricsLine } from "./metrics.js";
import { openItemLine, openOpenItems } from "./openitems.js";

/**
 * Composite session start: everything the session-start protocol needs in one
 * round trip — coaching context, open items (with overdue markers), the latest
 * journal entries in full plus older ones as headlines, and the pending
 * seed-update notice. Everything besides the context document fits
 * SESSION_EXTRAS_BUDGET_BYTES (see fitSessionExtras), so the payload is the
 * context document plus at most that; full history stays one get_journal /
 * search_knowledge call away. Archived entries collapse to headlines wherever they appear here, and a corrected
 * entry always carries its correction — the payload shrinks with age without
 * any statement losing its correction.
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
        "get_coaching_context / list_open_items / get_journal calls at the start of every session. " +
        "`scope` trims the payload for runs that need only a slice — the full payload is a fixed " +
        "per-session cost, so scheduled routines especially should ask only for what they use. Open items + " +
        "journal share a fixed byte budget: when they exceed it, full entries become headlines and item " +
        "bodies shorten, and the payload says what was trimmed.",
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
        scope: z
          .enum(["full", "context", "items"])
          .default("full")
          .describe(
            "'full' = context + open items + journal (the default); 'context' = the coaching " +
              "context document only; 'items' = open items + journal without the context document",
          ),
      },
    },
    ({ journal_full, journal_headlines, scope }) =>
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
        const entries = db
          .prepare(`SELECT ${JOURNAL_COLUMNS} FROM journal ORDER BY id DESC LIMIT ?`)
          .all(journal_full + journal_headlines) as JournalEntry[];

        // The size line, quota warning, staleness flags and the seed-update
        // notice ride along on every scope — they are the mechanical signals
        // a narrowed payload must not hide.
        const parts = [indexBudgetLine(db), warning.trim(), staleMetricsLine(db)];
        if (scope !== "items") {
          parts.push(context + notice);
        } else if (notice.length > 0) {
          parts.push(notice.trim());
        }
        if (scope !== "context") {
          parts.push("---", fitSessionExtras(items, entries, journal_full, journal_headlines));
        }
        return toolText(parts.filter((p) => p.length > 0).join("\n\n"));
      }),
  );
}

/**
 * Byte budget for everything start_session returns besides the context
 * document: open items plus the journal slice. The context document has its
 * own size signal (the index budget), so a full-scope payload is the document
 * plus at most this, no matter how many items or how long the entries get.
 * Clients cap tool output in tokens, and dense non-English markdown can run
 * close to 2 bytes per token, so 12 KB is roughly 6k tokens of extras.
 */
export const SESSION_EXTRAS_BUDGET_BYTES = 12_000;

/** Per-item body cap before the budget ladder has to shorten it further. */
const ITEM_INLINE_MAX = 500;

type ExtrasShape = { full: number; headlines: number; itemMax: number };

/**
 * Degradation ladder, cheapest loss first: demote full journal entries to
 * headlines (oldest first, the newest last), shorten item bodies, then drop
 * the oldest headlines. Open items are never dropped, only shortened: an
 * item missing from session start is a commitment nobody sees. Every shape
 * keeps the entry and item ids, so the recovery calls named in the output
 * always have what they need.
 */
function extrasLadder(full: number, headlines: number): ExtrasShape[] {
  const shapes: ExtrasShape[] = [];
  const total = full + headlines;
  for (let f = full; f >= Math.min(full, 1); f--) {
    shapes.push({ full: f, headlines: total - f, itemMax: ITEM_INLINE_MAX });
  }
  const f1 = Math.min(full, 1);
  shapes.push({ full: f1, headlines: total - f1, itemMax: 200 });
  shapes.push({ full: 0, headlines: total, itemMax: 200 });
  for (let h = total; h > 0; h = Math.floor(h / 2)) {
    shapes.push({ full: 0, headlines: h, itemMax: 80 });
  }
  shapes.push({ full: 0, headlines: 0, itemMax: 80 });
  return shapes;
}

function renderExtras(
  items: ReturnType<typeof openOpenItems>,
  entries: JournalEntry[],
  shape: ExtrasShape,
): string {
  const overdueCount = items.filter((i) => i.overdue).length;
  const itemsHeader = `## Open items (${items.length} open${overdueCount > 0 ? `, ${overdueCount} OVERDUE` : ""})`;
  // Each item's body is capped (the marker names list_open_items for the
  // full text): one very long commitment must not turn every future session
  // start into a file spill.
  const itemsBlock =
    items.length === 0
      ? "No open items."
      : items.map((r) => openItemLine(r, false, shape.itemMax)).join("\n");
  const fullEntries = entries.slice(0, shape.full);
  const headlineEntries = entries.slice(shape.full, shape.full + shape.headlines);

  const parts = [`${itemsHeader}\n\n${itemsBlock}`];
  if (fullEntries.length > 0) {
    // journalListed, not journalFull: an archived entry collapses to its
    // headline even in the newest slice — that is what archiving buys, a
    // session start that stops growing with journal age. The body cap is the
    // mechanical half of the same job: curation can be forgotten,
    // JOURNAL_INLINE_MAX cannot.
    parts.push(
      `## Journal — latest ${fullEntries.length === 1 ? "entry" : `${fullEntries.length} entries`} in full\n\n` +
        fullEntries.map((r) => journalListed(r, JOURNAL_INLINE_MAX)).join("\n\n---\n\n"),
    );
  }
  if (headlineEntries.length > 0) {
    parts.push(
      "## Journal — earlier headlines (get_journal with ids for full text)\n\n" +
        headlineEntries.map(journalHeadline).join("\n"),
    );
  }
  if (entries.length === 0) {
    parts.push("## Journal\n\nNo journal entries yet.");
  }
  return parts.join("\n\n");
}

/**
 * Open items + journal, rendered in the richest shape that fits
 * SESSION_EXTRAS_BUDGET_BYTES. A trimmed payload says so and names what was
 * cut, so the model knows to fetch rather than assume nothing more exists.
 */
export function fitSessionExtras(
  items: ReturnType<typeof openOpenItems>,
  entries: JournalEntry[],
  full: number,
  headlines: number,
  budget = SESSION_EXTRAS_BUDGET_BYTES,
): string {
  const ladder = extrasLadder(full, headlines);
  let text = "";
  for (const shape of ladder) {
    // The marker counts toward the budget: it is part of what the client receives.
    text =
      trimMarker(shape, ladder[0], entries.length, budget) + renderExtras(items, entries, shape);
    if (Buffer.byteLength(text, "utf8") <= budget) break;
  }
  return text;
}

function trimMarker(
  shape: ExtrasShape,
  requested: ExtrasShape,
  entryCount: number,
  budget: number,
): string {
  const cuts: string[] = [];
  const demoted = Math.min(requested.full, entryCount) - Math.min(shape.full, entryCount);
  if (demoted > 0)
    cuts.push(`${demoted} journal ${demoted === 1 ? "entry" : "entries"} shown as headline`);
  if (shape.itemMax < requested.itemMax) cuts.push(`item bodies capped at ${shape.itemMax} chars`);
  const omitted = entryCount - Math.min(entryCount, shape.full + shape.headlines);
  if (omitted > 0)
    cuts.push(`${omitted} older ${omitted === 1 ? "headline" : "headlines"} omitted`);
  if (cuts.length === 0) return "";
  return (
    `[budget] Open items + journal trimmed to fit ${formatBytes(budget)} B: ${cuts.join(", ")}. ` +
    "list_open_items and get_journal return the full text.\n\n"
  );
}
