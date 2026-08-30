import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JournalEntry, Reference, Section } from "../db.js";
import {
  formatBytes,
  indexBudgetBytes,
  indexBudgetLine,
  usageWarning,
  type WriteLimits,
} from "../quota.js";
import { loadSeedUpdates, pendingUpdates } from "../seed-updates.js";
import { toolText, withErrorHandling } from "../utils/errors.js";
import {
  correctionSnippet,
  JOURNAL_COLUMNS,
  journalFull,
  journalHeadline,
  journalListed,
} from "../utils/journal.js";
import { outlineSection } from "../utils/outline.js";
import { sanitizeFtsQuery, formatSearchHits, type SearchHit } from "../utils/search.js";

export function registerReadTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
  seedDir?: string,
): void {
  server.registerTool(
    "get_coaching_context",
    {
      title: "Get coaching context",
      description:
        "Get the full coaching context (SKILL.md). Call at the start of every coaching session.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      const row = db.prepare("SELECT content FROM sections WHERE name = 'main'").get() as
        | Section
        | undefined;
      // Session-start is where a near-quota warning reaches the agent earliest.
      const warning = usageWarning(db, limits);
      const context = row?.content ?? "No coaching context found. Database may not be seeded.";
      // Seed-update nudge: a tool agents merely COULD call is never called —
      // this line, on the one tool every session starts with, is what makes
      // the update protocol structural rather than optional.
      let notice = "";
      if (seedDir !== undefined) {
        const updates = loadSeedUpdates(seedDir);
        if (updates !== null) {
          const pending = pendingUpdates(db, updates).length;
          if (pending > 0) {
            notice = `\n\n---\n\n⚠ Seed guidance updates pending (${pending}) — call get_seed_updates and merge them per their Apply level before continuing.`;
          }
        }
      }
      const sizeLine = indexBudgetLine(db);
      const preamble = [sizeLine, warning.trim()].filter((p) => p.length > 0).join("\n\n");
      return toolText((preamble ? `${preamble}\n\n---\n\n${context}` : context) + notice);
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search knowledge",
      description:
        "Full-text search across coaching knowledge. Optional `type` scopes to one of section/reference/journal/routine; omitted searches all four.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().min(1).describe("Search terms"),
        type: z
          .enum(["section", "reference", "journal", "routine"])
          .optional()
          .describe("Filter: search only this table. Omit to search all."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("Max results per searched table"),
      },
    },
    ({ query, type, limit }) =>
      withErrorHandling("search_knowledge", () => {
        const fts = sanitizeFtsQuery(query);
        const hits: SearchHit[] = [];

        if (type === undefined || type === "section") {
          const rows = db
            .prepare(
              "SELECT s.name as name, snippet(sections_fts, 1, '**', '**', '...', 32) as snippet, s.updated_at as updated_at " +
                "FROM sections_fts JOIN sections s ON s.rowid = sections_fts.rowid " +
                "WHERE sections_fts MATCH ? ORDER BY rank LIMIT ?",
            )
            .all(fts, limit) as Array<{ name: string; snippet: string; updated_at: string }>;
          for (const r of rows) {
            hits.push({
              type: "section",
              name: r.name,
              date: r.updated_at.slice(0, 10),
              snippet: r.snippet,
            });
          }
        }

        if (type === undefined || type === "reference") {
          const rows = db
            .prepare(
              "SELECT r.name as name, snippet(refs_fts, 1, '**', '**', '...', 32) as snippet, r.updated_at as updated_at " +
                "FROM refs_fts JOIN refs r ON r.rowid = refs_fts.rowid " +
                "WHERE refs_fts MATCH ? ORDER BY rank LIMIT ?",
            )
            .all(fts, limit) as Array<{ name: string; snippet: string; updated_at: string }>;
          for (const r of rows) {
            hits.push({
              type: "reference",
              name: r.name,
              date: r.updated_at.slice(0, 10),
              snippet: r.snippet,
            });
          }
        }

        if (type === undefined || type === "journal") {
          // snippet column -1 = best-matching column, so a hit that lives in a
          // correction is quoted from the correction. Archived entries are
          // indexed like any other: archiving bounds session-start payload,
          // never findability.
          const rows = db
            .prepare(
              "SELECT j.id as id, snippet(journal_fts, -1, '**', '**', '...', 32) as snippet, " +
                "j.correction as correction, j.archived_at as archived_at, j.created_at as created_at " +
                "FROM journal_fts JOIN journal j ON j.id = journal_fts.rowid " +
                "WHERE journal_fts MATCH ? ORDER BY rank LIMIT ?",
            )
            .all(fts, limit) as Array<{
            id: number;
            snippet: string;
            correction: string | null;
            archived_at: string | null;
            created_at: string;
          }>;
          for (const r of rows) {
            hits.push({
              type: "journal",
              name: `#${r.id}`,
              date: r.created_at.slice(0, 10),
              snippet: r.snippet,
              flag: r.archived_at !== null ? "archived" : undefined,
              // A snippet of a corrected entry must never stand alone — the
              // hit would quote exactly the statement that was wrong.
              correction: r.correction === null ? undefined : correctionSnippet(r.correction),
            });
          }
        }

        if (type === undefined || type === "routine") {
          const rows = db
            .prepare(
              "SELECT r.name as name, snippet(routines_fts, 1, '**', '**', '...', 32) as snippet, r.updated_at as updated_at " +
                "FROM routines_fts JOIN routines r ON r.rowid = routines_fts.rowid " +
                "WHERE routines_fts MATCH ? ORDER BY rank LIMIT ?",
            )
            .all(fts, limit) as Array<{ name: string; snippet: string; updated_at: string }>;
          for (const r of rows) {
            hits.push({
              type: "routine",
              name: r.name,
              date: r.updated_at.slice(0, 10),
              snippet: r.snippet,
            });
          }
        }

        return toolText(formatSearchHits(hits, query));
      }),
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get reference",
      description:
        "Get a full coaching reference document by name (core: coaching-method, routine-design, patterns, lifestyle; plus topic-specific ones like zones or recipes).",
      inputSchema: {
        name: z.string().describe("Reference name without .md extension"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) =>
      withErrorHandling("get_reference", () => {
        const row = db.prepare("SELECT content FROM refs WHERE name = ?").get(name) as
          | Reference
          | undefined;
        if (!row) {
          const available = (
            db.prepare("SELECT name FROM refs ORDER BY name").all() as Array<{ name: string }>
          )
            .map((r) => r.name)
            .join(", ");
          return toolText(`Reference '${name}' not found. Available: ${available || "none"}`);
        }
        return toolText(row.content);
      }),
  );

  server.registerTool(
    "list_references",
    {
      title: "List references",
      description:
        "List all available reference documents (coaching-method, patterns, topic references, etc.) with name, last-updated date, and size in bytes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      withErrorHandling("list_references", () => {
        const rows = db
          .prepare("SELECT name, updated_at, LENGTH(content) as size FROM refs ORDER BY name")
          .all() as Array<{ name: string; updated_at: string; size: number }>;
        if (rows.length === 0) return toolText("No references defined yet.");
        return toolText(
          "Available references:\n" +
            rows
              .map((r) => `- **${r.name}** (updated ${r.updated_at}, ${r.size} bytes)`)
              .join("\n"),
        );
      }),
  );

  server.registerTool(
    "list_sections",
    {
      title: "List sections",
      description:
        "List all knowledge sections (typically just 'main') with name, last-updated date, and size in bytes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      withErrorHandling("list_sections", () => {
        const rows = db
          .prepare("SELECT name, updated_at, LENGTH(content) as size FROM sections ORDER BY name")
          .all() as Array<{ name: string; updated_at: string; size: number }>;
        if (rows.length === 0) return toolText("No sections defined.");
        return toolText(
          "Available sections:\n" +
            rows
              .map((r) => `- **${r.name}** (updated ${r.updated_at}, ${r.size} bytes)`)
              .join("\n"),
        );
      }),
  );

  server.registerTool(
    "get_section",
    {
      title: "Get section",
      description:
        "Get a knowledge section by name. Use 'main' for the canonical SKILL.md (equivalent to get_coaching_context).",
      inputSchema: {
        name: z.string().min(1).describe("Section name; use 'main' for SKILL.md"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) =>
      withErrorHandling("get_section", () => {
        const row = db.prepare("SELECT content FROM sections WHERE name = ?").get(name) as
          | Section
          | undefined;
        if (!row) {
          const available = (
            db.prepare("SELECT name FROM sections ORDER BY name").all() as Array<{ name: string }>
          )
            .map((r) => r.name)
            .join(", ");
          return toolText(`Section '${name}' not found. Available: ${available || "none"}`);
        }
        return toolText(row.content);
      }),
  );

  server.registerTool(
    "section_outline",
    {
      title: "Section outline",
      description:
        "Heading-level outline of a knowledge section with per-heading byte counts. Byte counts are " +
        "subtree totals (the heading plus everything under it — what offloading that block would save). " +
        "Use it when 'main' is over its index budget to pick which lookup-heavy block to move into a " +
        "reference, without re-reading the whole document.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        name: z.string().min(1).default("main").describe("Section name; defaults to 'main'"),
      },
    },
    ({ name }) =>
      withErrorHandling("section_outline", () => {
        const row = db.prepare("SELECT content FROM sections WHERE name = ?").get(name) as
          | Section
          | undefined;
        if (!row) {
          const available = (
            db.prepare("SELECT name FROM sections ORDER BY name").all() as Array<{ name: string }>
          )
            .map((r) => r.name)
            .join(", ");
          return toolText(`Section '${name}' not found. Available: ${available || "none"}`);
        }
        const outline = outlineSection(row.content);
        let header = `Outline of '${name}' — ${formatBytes(outline.totalBytes)} B total`;
        if (name === "main") {
          const budget = indexBudgetBytes();
          header +=
            outline.totalBytes > budget
              ? ` (index budget ${formatBytes(budget)} B — OVER by ${Math.round((outline.totalBytes / budget - 1) * 100)}%)`
              : ` (index budget ${formatBytes(budget)} B)`;
        }
        if (outline.entries.length === 0) {
          return toolText(`${header}\nNo headings found.`);
        }
        const width = Math.max(
          ...outline.entries.map((e) => formatBytes(e.subtreeBytes).length),
          outline.preambleBytes > 0 ? formatBytes(outline.preambleBytes).length : 0,
        );
        const lines: string[] = [];
        if (outline.preambleBytes > 0) {
          lines.push(`${formatBytes(outline.preambleBytes).padStart(width)} B  (preamble)`);
        }
        for (const e of outline.entries) {
          const own = e.ownBytes !== e.subtreeBytes ? ` (own ${formatBytes(e.ownBytes)} B)` : "";
          lines.push(
            `${formatBytes(e.subtreeBytes).padStart(width)} B  ${"#".repeat(e.level)} ${e.text}${own}`,
          );
        }
        return toolText(`${header}\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "get_journal",
    {
      title: "Get journal entries",
      description:
        "Get coaching journal entries, newest first. `limit` caps the count (default 10; with `since` default 50). " +
        "`since` (YYYY-MM-DD) scopes to entries from that date on — a note tells you when more matched than the limit. " +
        "`format: 'headlines'` returns one compact line per entry (#id, date, first line) for cheap scanning of long ranges; " +
        "`ids` fetches specific entries in full (e.g. picked from headlines or from search_knowledge journal hits), overriding since/limit. " +
        "Archived entries are listed as headlines and returned in full only by `ids`. Any correction attached to an " +
        "entry (see correct_journal) comes back with it in every format — an entry is never returned as if it still stood.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("ISO date YYYY-MM-DD — returns entries with created_at >= this date"),
        format: z
          .enum(["full", "headlines"])
          .default("full")
          .describe("'headlines' = one compact line per entry (first line only)"),
        ids: z
          .array(z.number().int())
          .max(20)
          .optional()
          .describe("Fetch these entry ids (overrides since/limit)"),
      },
    },
    ({ limit, since, format, ids }) =>
      withErrorHandling("get_journal", () => {
        let rows: JournalEntry[];
        let prefix = "";
        if (ids !== undefined && ids.length > 0) {
          const placeholders = ids.map(() => "?").join(",");
          rows = db
            .prepare(
              `SELECT ${JOURNAL_COLUMNS} FROM journal WHERE id IN (${placeholders}) ORDER BY id DESC`,
            )
            .all(...ids) as JournalEntry[];
          const missing = ids.filter((id) => !rows.some((r) => r.id === id));
          if (missing.length > 0) {
            prefix = `Note: no entry with id ${missing.map((id) => `#${id}`).join(", ")}.\n\n`;
          }
        } else if (since !== undefined) {
          const effectiveLimit = limit ?? 50;
          const total = (
            db.prepare("SELECT COUNT(*) AS n FROM journal WHERE created_at >= ?").get(since) as {
              n: number;
            }
          ).n;
          rows = db
            .prepare(
              `SELECT ${JOURNAL_COLUMNS} FROM journal WHERE created_at >= ? ORDER BY id DESC LIMIT ?`,
            )
            .all(since, effectiveLimit) as JournalEntry[];
          if (total > rows.length) {
            prefix = `Note: showing the newest ${rows.length} of ${total} entries since ${since} — use format: 'headlines', a higher limit, or a narrower range for the rest.\n\n`;
          }
        } else {
          const effectiveLimit = limit ?? (format === "headlines" ? 25 : 10);
          rows = db
            .prepare(`SELECT ${JOURNAL_COLUMNS} FROM journal ORDER BY id DESC LIMIT ?`)
            .all(effectiveLimit) as JournalEntry[];
        }
        if (rows.length === 0) {
          return toolText(`${prefix}No journal entries${since ? ` since ${since}` : ""} yet.`);
        }
        if (format === "headlines") {
          return toolText(prefix + rows.map(journalHeadline).join("\n"));
        }
        // An explicit `ids` fetch is the one path that expands archived
        // entries — it is how the full text of an archived entry is reached.
        const render = ids !== undefined && ids.length > 0 ? journalFull : journalListed;
        const archived = rows.filter((r) => r.archived_at !== null).length;
        const archivedNote =
          render === journalListed && archived > 0
            ? `Note: ${archived} archived ${archived === 1 ? "entry is" : "entries are"} shown as headlines — get_journal with ids for the full text.\n\n`
            : "";
        return toolText(prefix + archivedNote + rows.map(render).join("\n\n---\n\n"));
      }),
  );
}
