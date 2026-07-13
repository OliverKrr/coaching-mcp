import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JournalEntry, Reference, Section } from "../db.js";
import { usageWarning, type WriteLimits } from "../quota.js";
import { loadSeedUpdates, pendingUpdates } from "../seed-updates.js";
import { toolText, withErrorHandling } from "../utils/errors.js";
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
      description:
        "Get the full coaching context (SKILL.md). Call at the start of every coaching session.",
      inputSchema: {},
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
      return toolText((warning ? `${warning.trim()}\n\n---\n\n${context}` : context) + notice);
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      description:
        "Full-text search across coaching knowledge. Optional `type` scopes to one of section/reference/journal/routine; omitted searches all four.",
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
    ({ query, type, limit }) => {
      try {
        const fts = sanitizeFtsQuery(query);
        const hits: SearchHit[] = [];

        if (type === undefined || type === "section") {
          const rows = db
            .prepare(
              "SELECT s.name as name, snippet(sections_fts, 1, '**', '**', '...', 32) as snippet, s.updated_at as updated_at " +
                "FROM sections_fts JOIN sections s ON s.rowid = sections_fts.rowid " +
                "WHERE sections_fts MATCH ? LIMIT ?",
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
                "WHERE refs_fts MATCH ? LIMIT ?",
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
          const rows = db
            .prepare(
              "SELECT j.id as id, snippet(journal_fts, 0, '**', '**', '...', 32) as snippet, j.created_at as created_at " +
                "FROM journal_fts JOIN journal j ON j.id = journal_fts.rowid " +
                "WHERE journal_fts MATCH ? LIMIT ?",
            )
            .all(fts, limit) as Array<{ id: number; snippet: string; created_at: string }>;
          for (const r of rows) {
            hits.push({
              type: "journal",
              name: `#${r.id}`,
              date: r.created_at.slice(0, 10),
              snippet: r.snippet,
            });
          }
        }

        if (type === undefined || type === "routine") {
          const rows = db
            .prepare(
              "SELECT r.name as name, snippet(routines_fts, 1, '**', '**', '...', 32) as snippet, r.updated_at as updated_at " +
                "FROM routines_fts JOIN routines r ON r.rowid = routines_fts.rowid " +
                "WHERE routines_fts MATCH ? LIMIT ?",
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
      } catch {
        return toolText(
          "Search failed — try simpler terms (avoid special characters like quotes or parentheses).",
        );
      }
    },
  );

  server.registerTool(
    "get_reference",
    {
      description:
        "Get a full coaching reference document by name (core: coaching-method, routine-design, patterns, lifestyle; plus topic-specific ones like zones or recipes).",
      inputSchema: {
        name: z.string().describe("Reference name without .md extension"),
      },
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
      description:
        "List all available reference documents (coaching-method, patterns, topic references, etc.) with name, last-updated date, and size in bytes.",
      inputSchema: {},
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
      description:
        "List all knowledge sections (typically just 'main') with name, last-updated date, and size in bytes.",
      inputSchema: {},
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
      description:
        "Get a knowledge section by name. Use 'main' for the canonical SKILL.md (equivalent to get_coaching_context).",
      inputSchema: {
        name: z.string().min(1).describe("Section name; use 'main' for SKILL.md"),
      },
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
    "get_journal",
    {
      description:
        "Get recent coaching journal entries. Provide `since` (YYYY-MM-DD) for date-bounded queries, or `limit` for newest-N (default 10). If both are given, `since` wins and `limit` is ignored.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("ISO date YYYY-MM-DD — returns entries with created_at >= this date"),
      },
    },
    ({ limit, since }) =>
      withErrorHandling("get_journal", () => {
        let rows: JournalEntry[];
        let prefix = "";
        if (since !== undefined) {
          if (limit !== undefined) {
            prefix = "Note: 'limit' was ignored because 'since' was provided.\n\n";
          }
          rows = db
            .prepare(
              "SELECT id, entry, created_at FROM journal WHERE created_at >= ? ORDER BY id DESC",
            )
            .all(since) as JournalEntry[];
        } else {
          const effectiveLimit = limit ?? 10;
          rows = db
            .prepare("SELECT id, entry, created_at FROM journal ORDER BY id DESC LIMIT ?")
            .all(effectiveLimit) as JournalEntry[];
        }
        if (rows.length === 0) {
          return toolText(`${prefix}No journal entries${since ? ` since ${since}` : ""} yet.`);
        }
        return toolText(
          prefix + rows.map((r) => `[${r.created_at}] ${r.entry}`).join("\n\n---\n\n"),
        );
      }),
  );
}
