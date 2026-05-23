import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";

export function registerWriteTools(server: McpServer, db: Database.Database): void {
	server.tool(
		"update_section",
		"Update or create a coaching knowledge section. Use 'main' for the primary SKILL.md content. Creates the section if it does not exist.",
		{
			name: z.string().min(1).describe("Section name — use 'main' for SKILL.md"),
			content: z.string().min(1).describe("Full replacement content"),
		},
		({ name, content }) => {
			db.prepare(
				"INSERT INTO sections(name, content) VALUES (?, ?)" +
					" ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
			).run(name, content);
			return { content: [{ type: "text" as const, text: `Section '${name}' updated.` }] };
		},
	);

	server.tool(
		"update_reference",
		"Update or create a reference document (zones, strength, workout-construction, patterns, lifestyle).",
		{
			name: z.string().min(1).describe("Reference name without .md extension"),
			content: z.string().min(1).describe("Full replacement content"),
		},
		({ name, content }) => {
			db.prepare(
				"INSERT INTO refs(name, content) VALUES (?, ?)" +
					" ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
			).run(name, content);
			return { content: [{ type: "text" as const, text: `Reference '${name}' updated.` }] };
		},
	);

	server.tool(
		"append_journal",
		"Append a coaching journal entry. Call at the end of every session to log decisions made, data changed, and observations for future sessions.",
		{ entry: z.string().min(1).describe("Journal entry text") },
		({ entry }) => {
			const result = db
				.prepare("INSERT INTO journal(entry) VALUES (?)")
				.run(entry);
			return {
				content: [{ type: "text" as const, text: `Journal entry #${result.lastInsertRowid} saved.` }],
			};
		},
	);
}
