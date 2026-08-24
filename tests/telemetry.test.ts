import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import {
  createToolUsageSchema,
  instrumentToolCalls,
  pruneToolUsage,
  recordToolUsage,
  telemetryName,
  toolUsageSummary,
  type ToolCallOutcome,
} from "../src/telemetry.js";
import { registerReadTools } from "../src/tools/read.js";
import { toolError, toolText } from "../src/utils/errors.js";

function usageDb(): Database.Database {
  const db = new Database(":memory:");
  createToolUsageSchema(db);
  return db;
}

describe("tool_usage counters", () => {
  it("upserts per (day, user, tool) and aggregates across users", () => {
    const db = usageDb();
    recordToolUsage(db, "u1", "start_session", { error: false, empty: false });
    recordToolUsage(db, "u1", "start_session", { error: true, empty: false });
    recordToolUsage(db, "u2", "start_session", { error: false, empty: false });
    recordToolUsage(db, "u1", "search_knowledge:journal", { error: false, empty: true });
    const summary = toolUsageSummary(db, 90);
    expect(summary[0]).toMatchObject({ tool: "start_session", calls: 3, errors: 1, users: 2 });
    expect(summary[1]).toMatchObject({ tool: "search_knowledge:journal", calls: 1, empty: 1 });
  });

  it("prunes rows past the retention window", () => {
    const db = usageDb();
    db.prepare(
      "INSERT INTO tool_usage(day, user_id, tool, calls) VALUES ('2020-01-01', 'u1', 'old_tool', 5)",
    ).run();
    recordToolUsage(db, "u1", "fresh_tool", { error: false, empty: false });
    pruneToolUsage(db, 180);
    const tools = db.prepare("SELECT tool FROM tool_usage ORDER BY tool").all() as Array<{
      tool: string;
    }>;
    expect(tools).toEqual([{ tool: "fresh_tool" }]);
  });

  it("telemetryName splits search_knowledge by scope", () => {
    expect(telemetryName("search_knowledge", { type: "journal" })).toBe("search_knowledge:journal");
    expect(telemetryName("search_knowledge", {})).toBe("search_knowledge:all");
    expect(telemetryName("get_journal", { type: "journal" })).toBe("get_journal");
  });
});

describe("instrumentToolCalls", () => {
  async function instrumentedClient(): Promise<{
    client: Client;
    events: Array<[string, ToolCallOutcome]>;
  }> {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    createSchema(db);
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'findableword here')").run();
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool("ok_tool", { description: "always succeeds", inputSchema: {} }, () =>
      toolText("fine"),
    );
    server.registerTool("bad_tool", { description: "always fails", inputSchema: {} }, () =>
      toolError("nope"),
    );
    registerReadTools(server, db);
    const events: Array<[string, ToolCallOutcome]> = [];
    instrumentToolCalls(server, (tool, outcome) => events.push([tool, outcome]));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return { client, events };
  }

  it("counts calls, errors, and empty search results through the protocol layer", async () => {
    const { client, events } = await instrumentedClient();
    await client.callTool({ name: "ok_tool", arguments: {} });
    await client.callTool({ name: "bad_tool", arguments: {} });
    await client.callTool({
      name: "search_knowledge",
      arguments: { query: "zzzunfindable", type: "journal" },
    });
    await client.callTool({ name: "search_knowledge", arguments: { query: "findableword" } });
    expect(events).toEqual([
      ["ok_tool", { error: false, empty: false }],
      ["bad_tool", { error: true, empty: false }],
      ["search_knowledge:journal", { error: false, empty: true }],
      ["search_knowledge:all", { error: false, empty: false }],
    ]);
  });

  it("a throwing recorder never breaks the tool call", async () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    createSchema(db);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool("ok_tool", { description: "always succeeds", inputSchema: {} }, () =>
      toolText("fine"),
    );
    instrumentToolCalls(server, () => {
      throw new Error("recorder down");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = (await client.callTool({ name: "ok_tool", arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toBe("fine");
  });
});
