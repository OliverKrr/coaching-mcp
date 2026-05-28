// coaching-mcp/tests/ops.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerOpsTools } from "../src/tools/ops.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
  _registeredTools: ToolMap;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeOpsServer(): { server: McpServer; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'x')").run();
  db.prepare("INSERT INTO refs(name, content) VALUES ('a', 'y')").run();
  db.prepare("INSERT INTO refs(name, content) VALUES ('b', 'z')").run();
  db.prepare("INSERT INTO journal(entry) VALUES ('j1')").run();
  db.prepare("INSERT INTO journal(entry) VALUES ('j2')").run();
  db.prepare("INSERT INTO journal(entry) VALUES ('j3')").run();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerOpsTools(server, db);
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

describe("get_version", () => {
  it("returns name, version, node_version, db info", async () => {
    const { server } = makeOpsServer();
    const result = await callTool(server, "get_version", {});
    const info = JSON.parse(result.content[0].text);
    expect(info.name).toBe("coaching-mcp");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.node_version).toMatch(/^v\d+/);
    expect(info.db_path).toContain("skill.db");
  });

  it("counts match db state", async () => {
    const { server } = makeOpsServer();
    const result = await callTool(server, "get_version", {});
    const info = JSON.parse(result.content[0].text);
    expect(info.sections_count).toBe(1);
    expect(info.refs_count).toBe(2);
    expect(info.journal_count).toBe(3);
  });
});
