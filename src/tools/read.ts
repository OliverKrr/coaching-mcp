import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JournalEntry, Reference, Section } from "../db.js";
import { toolText, withErrorHandling } from "../utils/errors.js";
import { sanitizeFtsQuery } from "../utils/search.js";

export function registerReadTools(server: McpServer, db: Database.Database): void {
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
      return toolText(row?.content ?? "No coaching context found. Database may not be seeded.");
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      description:
        "Full-text search across all coaching knowledge: sections, references, and coaching journal entries.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("Max results per table (sections, refs, journal)"),
      },
    },
    ({ query, limit }) => {
      const fts = sanitizeFtsQuery(query);
      try {
        const sections = db
          .prepare(
            "SELECT name, snippet(sections_fts, 1, '**', '**', '...', 32) as snippet FROM sections_fts WHERE sections_fts MATCH ? LIMIT ?",
          )
          .all(fts, limit) as Array<{ name: string; snippet: string }>;

        const refs = db
          .prepare(
            "SELECT name, snippet(refs_fts, 1, '**', '**', '...', 32) as snippet FROM refs_fts WHERE refs_fts MATCH ? LIMIT ?",
          )
          .all(fts, limit) as Array<{ name: string; snippet: string }>;

        const journal = db
          .prepare(
            "SELECT rowid as id, snippet(journal_fts, 0, '**', '**', '...', 32) as snippet FROM journal_fts WHERE journal_fts MATCH ? LIMIT ?",
          )
          .all(fts, limit) as Array<{ id: number; snippet: string }>;

        const parts: string[] = [];
        if (sections.length > 0)
          parts.push(
            "**Sections:**\n" + sections.map((r) => `[${r.name}]: ${r.snippet}`).join("\n"),
          );
        if (refs.length > 0)
          parts.push("**References:**\n" + refs.map((r) => `[${r.name}]: ${r.snippet}`).join("\n"));
        if (journal.length > 0)
          parts.push("**Journal:**\n" + journal.map((r) => `[#${r.id}]: ${r.snippet}`).join("\n"));

        return toolText(parts.length > 0 ? parts.join("\n\n") : `No results found for: ${query}`);
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
        "Get a full coaching reference document by name (e.g. zones, strength, workout-construction, patterns, lifestyle).",
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
    "get_journal",
    {
      description:
        "Get recent coaching journal entries — decisions, updates, and observations from past coaching sessions.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    ({ limit }) =>
      withErrorHandling("get_journal", () => {
        const rows = db
          .prepare("SELECT id, entry, created_at FROM journal ORDER BY id DESC LIMIT ?")
          .all(limit) as JournalEntry[];
        return toolText(
          rows.length === 0
            ? "No journal entries yet."
            : rows.map((r) => `[${r.created_at}] ${r.entry}`).join("\n\n---\n\n"),
        );
      }),
  );
}
