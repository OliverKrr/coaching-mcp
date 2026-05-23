import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { JournalEntry, Reference, Section } from "../db.js";

export function registerReadTools(server: McpServer, db: Database.Database): void {
	server.tool(
		"get_coaching_context",
		"Get the full coaching context (SKILL.md). Call at the start of every coaching session.",
		{},
		() => {
			const row = db
				.prepare("SELECT content FROM sections WHERE name = 'main'")
				.get() as Section | undefined;
			return {
				content: [
					{
						type: "text" as const,
						text: row?.content ?? "No coaching context found. Database may not be seeded.",
					},
				],
			};
		},
	);

	server.tool(
		"search_knowledge",
		"Full-text search across all coaching content: sections, references, and journal entries.",
		{
			query: z.string().min(1).describe("Search terms"),
			limit: z.number().int().min(1).max(20).default(5).describe("Max results per table (sections, refs, journal)"),
		},
		({ query, limit }) => {
			try {
				const sections = db
					.prepare(
						"SELECT name, snippet(sections_fts, 1, '**', '**', '...', 32) as snippet FROM sections_fts WHERE sections_fts MATCH ? LIMIT ?",
					)
					.all(query, limit) as Array<{ name: string; snippet: string }>;

				const refs = db
					.prepare(
						"SELECT name, snippet(refs_fts, 1, '**', '**', '...', 32) as snippet FROM refs_fts WHERE refs_fts MATCH ? LIMIT ?",
					)
					.all(query, limit) as Array<{ name: string; snippet: string }>;

				const journal = db
					.prepare(
						"SELECT rowid as id, snippet(journal_fts, 0, '**', '**', '...', 32) as snippet FROM journal_fts WHERE journal_fts MATCH ? LIMIT ?",
					)
					.all(query, limit) as Array<{ id: number; snippet: string }>;

				const parts: string[] = [];
				if (sections.length > 0)
					parts.push("**Sections:**\n" + sections.map((r) => `[${r.name}]: ${r.snippet}`).join("\n"));
				if (refs.length > 0)
					parts.push("**References:**\n" + refs.map((r) => `[${r.name}]: ${r.snippet}`).join("\n"));
				if (journal.length > 0)
					parts.push("**Journal:**\n" + journal.map((r) => `[#${r.id}]: ${r.snippet}`).join("\n"));

				return {
					content: [
						{
							type: "text" as const,
							text: parts.length > 0 ? parts.join("\n\n") : `No results found for: ${query}`,
						},
					],
				};
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: "Search failed — try simpler terms (avoid special characters like quotes or parentheses).",
						},
					],
				};
			}
		},
	);

	server.tool(
		"get_reference",
		"Get a full reference document by name (e.g. zones, strength, workout-construction, patterns, lifestyle).",
		{ name: z.string().describe("Reference name without .md extension") },
		({ name }) => {
			const row = db.prepare("SELECT content FROM refs WHERE name = ?").get(name) as
				| Reference
				| undefined;
			if (!row) {
				const available = (
					db.prepare("SELECT name FROM refs ORDER BY name").all() as Array<{ name: string }>
				)
					.map((r) => r.name)
					.join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `Reference '${name}' not found. Available: ${available || "none"}`,
						},
					],
				};
			}
			return { content: [{ type: "text" as const, text: row.content }] };
		},
	);

	server.tool(
		"get_journal",
		"Get recent coaching journal entries — decisions, updates, and observations from past sessions.",
		{ limit: z.number().int().min(1).max(50).default(10) },
		({ limit }) => {
			const rows = db
				.prepare("SELECT id, entry, created_at FROM journal ORDER BY id DESC LIMIT ?")
				.all(limit) as JournalEntry[];
			return {
				content: [
					{
						type: "text" as const,
						text:
							rows.length === 0
								? "No journal entries yet."
								: rows.map((r) => `[${r.created_at}] ${r.entry}`).join("\n\n---\n\n"),
					},
				],
			};
		},
	);
}
