import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerOpenItemsTools } from "../src/tools/openitems.js";

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
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerOpenItemsTools(server, db);
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

describe("add_open_item", () => {
  it("adds a commitment", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "add_open_item", {
      kind: "commitment",
      content: "Tue threshold after work",
    });
    expect(r.content[0].text).toContain("added (commitment)");
  });

  it("dedups a flag with the same key while open", async () => {
    const { server } = makeServer();
    await callTool(server, "add_open_item", {
      kind: "flag",
      content: "HRV low",
      dedup_key: "hrv-low-w26",
    });
    const r = await callTool(server, "add_open_item", {
      kind: "flag",
      content: "HRV low again",
      dedup_key: "hrv-low-w26",
    });
    expect(r.content[0].text).toContain("already open (dedup");
  });

  it("does NOT dedup across different keys", async () => {
    const { server } = makeServer();
    await callTool(server, "add_open_item", { kind: "flag", content: "a", dedup_key: "k1" });
    const r = await callTool(server, "add_open_item", {
      kind: "flag",
      content: "b",
      dedup_key: "k2",
    });
    expect(r.content[0].text).toContain("added (flag)");
  });

  it("does NOT dedup against a resolved item (same key re-opens)", async () => {
    const { server } = makeServer();
    const a = await callTool(server, "add_open_item", {
      kind: "flag",
      content: "a",
      dedup_key: "k1",
    });
    const id = Number(a.content[0].text.match(/#(\d+)/)![1]);
    await callTool(server, "resolve_open_item", { id, status: "done" });
    const r = await callTool(server, "add_open_item", {
      kind: "flag",
      content: "a again",
      dedup_key: "k1",
    });
    expect(r.content[0].text).toContain("added (flag)");
  });

  it("stores relevant_date and shows it in list", async () => {
    const { server } = makeServer();
    await callTool(server, "add_open_item", {
      kind: "commitment",
      content: "long run",
      relevant_date: "2026-06-28",
    });
    const r = await callTool(server, "list_open_items", {});
    expect(r.content[0].text).toContain("(2026-06-28)");
  });
});

describe("list_open_items", () => {
  it("defaults to open only", async () => {
    const { server } = makeServer();
    const a = await callTool(server, "add_open_item", { kind: "flag", content: "keep" });
    const b = await callTool(server, "add_open_item", { kind: "flag", content: "close" });
    const closeId = Number(b.content[0].text.match(/#(\d+)/)![1]);
    await callTool(server, "resolve_open_item", { id: closeId, status: "dismissed" });
    const r = await callTool(server, "list_open_items", {});
    expect(r.content[0].text).toContain("keep");
    expect(r.content[0].text).not.toContain("close");
    expect(a.content[0].text).toContain("added");
  });

  it("filters by kind", async () => {
    const { server } = makeServer();
    await callTool(server, "add_open_item", { kind: "commitment", content: "a-commit" });
    await callTool(server, "add_open_item", { kind: "flag", content: "a-flag" });
    const r = await callTool(server, "list_open_items", { kind: "flag" });
    expect(r.content[0].text).toContain("a-flag");
    expect(r.content[0].text).not.toContain("a-commit");
  });

  it("returns newest-first", async () => {
    const { server } = makeServer();
    await callTool(server, "add_open_item", { kind: "flag", content: "first" });
    await callTool(server, "add_open_item", { kind: "flag", content: "second" });
    const text = (await callTool(server, "list_open_items", {})).content[0].text;
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));
  });

  it("reports emptiness", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "list_open_items", {});
    expect(r.content[0].text).toContain("No open open items");
  });
});

describe("resolve_open_item", () => {
  it("marks done and appends a note", async () => {
    const { server } = makeServer();
    const a = await callTool(server, "add_open_item", { kind: "commitment", content: "do X" });
    const id = Number(a.content[0].text.match(/#(\d+)/)![1]);
    const r = await callTool(server, "resolve_open_item", {
      id,
      status: "done",
      note: "went well",
    });
    expect(r.content[0].text).toContain(`#${id} marked done`);
    const done = await callTool(server, "list_open_items", { status: "done" });
    expect(done.content[0].text).toContain("resolved: went well");
  });

  it("returns not-found for a bad id", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "resolve_open_item", { id: 999, status: "done" });
    expect(r.content[0].text).toContain("not found");
  });
});
