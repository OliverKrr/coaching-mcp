// skill-mcp/tests/tools.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerWriteTools } from "../src/tools/write.js";
import type { Section, Reference, JournalEntry } from "../src/db.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
	_registeredTools: ToolMap;
	validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
	executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeServer(): { server: McpServer; db: Database.Database } {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	createSchema(db);
	db.prepare("INSERT INTO sections(name, content) VALUES ('main', ?)").run(
		"Calf injury rules: no heavy lifts. FTP 414W. Köln marathon sub-2:45.",
	);
	db.prepare("INSERT INTO refs(name, content) VALUES ('zones', ?)").run(
		"Z1: 100–120 bpm easy. Z2: 120–133 bpm. Threshold: 166 bpm.",
	);
	db.prepare("INSERT INTO journal(entry) VALUES (?)").run(
		"Session 1: athlete ran 15 km easy, HR controlled.",
	);
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerReadTools(server, db);
	registerWriteTools(server, db);
	return { server, db };
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const internal = server as unknown as InternalServer;
	const tool = internal._registeredTools[name];
	if (!tool) throw new Error(`Tool '${name}' not registered`);
	const validatedArgs = await internal.validateToolInput(tool, args, name);
	return internal.executeToolHandler(tool, validatedArgs, {});
}

describe("get_coaching_context", () => {
	it("returns main section content", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "get_coaching_context", {});
		expect(result.content[0].text).toContain("FTP 414W");
	});
});

describe("search_knowledge", () => {
	it("finds content in sections", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "search_knowledge", { query: "calf", limit: 5 });
		expect(result.content[0].text).toContain("Calf");
	});

	it("finds content in refs", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "search_knowledge", { query: "threshold", limit: 5 });
		expect(result.content[0].text).toContain("hreshold");
	});

	it("finds content in journal", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "search_knowledge", { query: "easy", limit: 5 });
		expect(result.content[0].text).toMatch(/easy|Session/i);
	});

	it("returns no-results message for unmatched query", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "search_knowledge", { query: "xyznotfound123", limit: 5 });
		expect(result.content[0].text).toContain("No results");
	});
});

describe("get_reference", () => {
	it("returns reference content by name", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "get_reference", { name: "zones" });
		expect(result.content[0].text).toContain("Z1: 100–120");
	});

	it("lists available refs when name not found", async () => {
		const { server } = makeServer();
		const result = await callTool(server, "get_reference", { name: "nonexistent" });
		expect(result.content[0].text).toContain("not found");
		expect(result.content[0].text).toContain("zones");
	});
});

describe("get_journal", () => {
	it("returns entries newest first", async () => {
		const { server, db } = makeServer();
		db.prepare("INSERT INTO journal(entry) VALUES (?)").run("Session 2: strength workout done.");
		const result = await callTool(server, "get_journal", { limit: 10 });
		const text = result.content[0].text;
		expect(text.indexOf("Session 2")).toBeLessThan(text.indexOf("Session 1"));
	});
});
