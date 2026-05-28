// coaching-mcp/tests/tools.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerWriteTools } from "../src/tools/write.js";

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

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
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
    const result = await callTool(server, "search_knowledge", {
      query: "xyznotfound123",
      limit: 5,
    });
    expect(result.content[0].text).toContain("No results");
  });

  it("does not crash on FTS5 special chars (parens)", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", { query: "Z2(low)", limit: 5 });
    expect(result.content[0].text).not.toContain("Search failed");
    expect(result.content[0].text).toContain("No results");
  });

  it("does not crash on FTS5 special chars (colon)", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", { query: "name:value", limit: 5 });
    expect(result.content[0].text).not.toContain("Search failed");
    expect(result.content[0].text).toContain("No results");
  });

  it("type filter scopes to sections only", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", {
      query: "calf",
      type: "section",
      limit: 5,
    });
    expect(result.content[0].text).toContain("[section]");
    expect(result.content[0].text).not.toContain("[reference]");
    expect(result.content[0].text).not.toContain("[journal]");
  });

  it("type filter scopes to references only", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", {
      query: "Z1",
      type: "reference",
      limit: 5,
    });
    expect(result.content[0].text).toContain("[reference]");
    expect(result.content[0].text).not.toContain("[section]");
  });

  it("type filter scopes to journal only", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", {
      query: "Session",
      type: "journal",
      limit: 5,
    });
    expect(result.content[0].text).toContain("[journal]");
    expect(result.content[0].text).not.toContain("[section]");
  });

  it("searches all when type omitted", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", { query: "calf", limit: 5 });
    expect(result.content[0].text).toContain("[section]");
  });

  it("output uses header + > snippet shape", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "search_knowledge", { query: "calf", limit: 5 });
    expect(result.content[0].text).toMatch(/\[section\] main \(updated \d{4}-\d{2}-\d{2}\)\n> /);
  });
});

describe("list_references", () => {
  it("returns all references with metadata", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "list_references", {});
    expect(result.content[0].text).toContain("zones");
    expect(result.content[0].text).toContain("bytes");
  });

  it("returns empty message when no refs exist", async () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    createSchema(db);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerReadTools(server, db);
    const result = await callTool(server, "list_references", {});
    expect(result.content[0].text).toContain("No references");
  });

  it("returns sorted by name", async () => {
    const { server, db } = makeServer();
    db.prepare("INSERT INTO refs(name, content) VALUES (?, ?)").run("aaa", "A");
    db.prepare("INSERT INTO refs(name, content) VALUES (?, ?)").run("mmm", "B");
    const result = await callTool(server, "list_references", {});
    const text = result.content[0].text;
    const aIdx = text.indexOf("aaa");
    const mIdx = text.indexOf("mmm");
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(mIdx);
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

  it("respects since parameter (boundary inclusive)", async () => {
    const { server, db } = makeServer();
    db.prepare("INSERT INTO journal(entry, created_at) VALUES (?, ?)").run(
      "older entry",
      "2024-01-01 00:00:00",
    );
    db.prepare("INSERT INTO journal(entry, created_at) VALUES (?, ?)").run(
      "newer entry",
      "2026-05-01 00:00:00",
    );
    const result = await callTool(server, "get_journal", { since: "2025-01-01" });
    expect(result.content[0].text).toContain("newer entry");
    expect(result.content[0].text).not.toContain("older entry");
  });

  it("includes notice line when both since and limit are set", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "get_journal", { since: "2024-01-01", limit: 1 });
    expect(result.content[0].text).toContain("Note:");
    expect(result.content[0].text).toContain("limit");
  });

  it("returns dated empty message when nothing matches since", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "get_journal", { since: "2099-01-01" });
    expect(result.content[0].text).toContain("since 2099-01-01");
  });

  it("respects explicit limit when since omitted", async () => {
    const { server, db } = makeServer();
    db.prepare("INSERT INTO journal(entry) VALUES (?)").run("entry 2");
    db.prepare("INSERT INTO journal(entry) VALUES (?)").run("entry 3");
    const result = await callTool(server, "get_journal", { limit: 1 });
    expect(result.content[0].text).toContain("entry 3");
    expect(result.content[0].text).not.toContain("entry 2");
  });
});

describe("list_sections", () => {
  it("returns sections with metadata", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "list_sections", {});
    expect(result.content[0].text).toContain("main");
    expect(result.content[0].text).toContain("bytes");
  });
});

describe("get_section", () => {
  it("returns content for existing section", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "get_section", { name: "main" });
    expect(result.content[0].text).toContain("FTP 414W");
  });

  it("returns 'not found' for missing section with available list", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "get_section", { name: "nonexistent" });
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("main");
  });

  it("get_section('main') equals get_coaching_context() after trimEnd", async () => {
    const { server } = makeServer();
    const a = (await callTool(server, "get_section", { name: "main" })).content[0].text;
    const b = (await callTool(server, "get_coaching_context", {})).content[0].text;
    expect(a.trimEnd()).toBe(b.trimEnd());
  });
});

describe("update_section", () => {
  it("updates existing section content", async () => {
    const { server, db } = makeServer();
    await callTool(server, "update_section", { name: "main", content: "Updated FTP 420W." });
    const row = db.prepare("SELECT content FROM sections WHERE name='main'").get() as {
      content: string;
    };
    expect(row.content).toBe("Updated FTP 420W.");
  });

  it("creates a new section if name does not exist", async () => {
    const { server, db } = makeServer();
    await callTool(server, "update_section", { name: "notes", content: "Extra notes." });
    const row = db.prepare("SELECT content FROM sections WHERE name='notes'").get() as {
      content: string;
    };
    expect(row.content).toBe("Extra notes.");
  });

  it("updated content is searchable via FTS", async () => {
    const { server } = makeServer();
    await callTool(server, "update_section", { name: "main", content: "xyzunique999 special." });
    const result = await callTool(server, "search_knowledge", { query: "xyzunique999", limit: 5 });
    expect(result.content[0].text).toContain("xyzunique999");
  });
});

describe("update_reference", () => {
  it("updates existing reference", async () => {
    const { server, db } = makeServer();
    await callTool(server, "update_reference", {
      name: "zones",
      content: "Z1: 105–125 bpm updated.",
    });
    const row = db.prepare("SELECT content FROM refs WHERE name='zones'").get() as {
      content: string;
    };
    expect(row.content).toContain("105–125");
  });

  it("creates new reference if not exists", async () => {
    const { server, db } = makeServer();
    await callTool(server, "update_reference", {
      name: "nutrition",
      content: "Carb periodization.",
    });
    const row = db.prepare("SELECT content FROM refs WHERE name='nutrition'").get() as {
      content: string;
    };
    expect(row.content).toContain("Carb");
  });
});

describe("append_journal", () => {
  it("adds a journal entry", async () => {
    const { server, db } = makeServer();
    await callTool(server, "append_journal", { entry: "Updated FTP to 420W after test." });
    const rows = db.prepare("SELECT entry FROM journal ORDER BY id DESC LIMIT 1").all() as Array<{
      entry: string;
    }>;
    expect(rows[0].entry).toContain("Updated FTP to 420W");
  });

  it("journal entry is searchable", async () => {
    const { server } = makeServer();
    await callTool(server, "append_journal", { entry: "Athlete races better with 3-day taper." });
    const result = await callTool(server, "search_knowledge", { query: "taper", limit: 5 });
    expect(result.content[0].text).toContain("taper");
  });
});
