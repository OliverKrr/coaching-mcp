// coaching-mcp/tests/delete.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerDeleteTools } from "../src/tools/delete.js";

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
  db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'main content')").run();
  db.prepare("INSERT INTO refs(name, content) VALUES ('zones', 'Z1: easy')").run();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, db); // for search_knowledge in cascade tests
  registerDeleteTools(server, db);
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

describe("delete_section", () => {
  it("rejects without confirm=true (Zod validation)", async () => {
    const { server } = makeServer();
    await expect(callTool(server, "delete_section", { name: "throwaway" })).rejects.toThrow();
  });

  it("rejects with confirm=false", async () => {
    const { server } = makeServer();
    await expect(
      callTool(server, "delete_section", { name: "throwaway", confirm: false }),
    ).rejects.toThrow();
  });

  it("refuses to delete 'main'", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "delete_section", {
      name: "main",
      confirm: true,
    });
    expect(result.content[0].text).toContain("Cannot delete 'main'");
  });

  it("returns 'not found' for missing section", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "delete_section", { name: "nope", confirm: true });
    expect(result.content[0].text).toContain("not found");
  });

  it("FTS5 index cleaned (search after delete returns 0 hits)", async () => {
    const { server, db } = makeServer();
    db.prepare("INSERT INTO sections(name, content) VALUES (?, ?)").run(
      "throwaway",
      "unique-section-marker-zzz",
    );
    let result = await callTool(server, "search_knowledge", {
      query: "unique-section-marker-zzz",
      limit: 5,
    });
    expect(result.content[0].text).toContain("unique-section-marker-zzz");
    await callTool(server, "delete_section", { name: "throwaway", confirm: true });
    result = await callTool(server, "search_knowledge", {
      query: "unique-section-marker-zzz",
      limit: 5,
    });
    expect(result.content[0].text).toContain("No results found");
  });
});

describe("delete_reference", () => {
  it("rejects without confirm=true", async () => {
    const { server } = makeServer();
    await expect(callTool(server, "delete_reference", { name: "zones" })).rejects.toThrow();
  });

  it("deletes a reference and removes it from FTS5", async () => {
    const { server, db } = makeServer();
    db.prepare("INSERT INTO refs(name, content) VALUES (?, ?)").run(
      "throwaway",
      "unique-ref-marker-zzz",
    );
    await callTool(server, "delete_reference", { name: "throwaway", confirm: true });
    const result = await callTool(server, "search_knowledge", {
      query: "unique-ref-marker-zzz",
      limit: 5,
    });
    expect(result.content[0].text).toContain("No results found");
  });
});
