// coaching-mcp/tests/routines.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerRoutineTools } from "../src/tools/routines.js";

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
  registerReadTools(server, db);
  registerRoutineTools(server, db);
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

const WEEKLY = {
  name: "weekly-review",
  cadence: "weekly, Sunday ~19:00",
  prompt: "Load the coaching context and write the check-in of record.",
};

describe("save_routine", () => {
  it("creates with default status active", async () => {
    const { server, db } = makeServer();
    const result = await callTool(server, "save_routine", WEEKLY);
    expect(result.content[0].text).toContain("saved");
    const row = db.prepare("SELECT status FROM routines WHERE name = 'weekly-review'").get() as {
      status: string;
    };
    expect(row.status).toBe("active");
  });

  it("upserts: updates cadence/prompt and keeps status when omitted", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_routine", { ...WEEKLY, status: "paused" });
    await callTool(server, "save_routine", {
      ...WEEKLY,
      cadence: "biweekly",
      prompt: "Lighter cadence now.",
    });
    const row = db.prepare("SELECT * FROM routines WHERE name = 'weekly-review'").get() as {
      cadence: string;
      prompt: string;
      status: string;
    };
    expect(row.cadence).toBe("biweekly");
    expect(row.prompt).toBe("Lighter cadence now.");
    expect(row.status).toBe("paused"); // omitted status preserved on update

    await callTool(server, "save_routine", { ...WEEKLY, status: "retired" });
    const after = db.prepare("SELECT status FROM routines WHERE name = 'weekly-review'").get() as {
      status: string;
    };
    expect(after.status).toBe("retired");
  });

  it("rejects an unknown status", async () => {
    const { server } = makeServer();
    await expect(
      callTool(server, "save_routine", { ...WEEKLY, status: "bogus" }),
    ).rejects.toThrow();
  });
});

describe("list_routines / get_routine", () => {
  it("lists all with active first, filters by status, and reports empty", async () => {
    const { server } = makeServer();
    const empty = await callTool(server, "list_routines", {});
    expect(empty.content[0].text).toContain("No routines stored yet");
    expect(empty.content[0].text).toContain("routine-design");

    await callTool(server, "save_routine", { ...WEEKLY, name: "a-retired", status: "retired" });
    await callTool(server, "save_routine", { ...WEEKLY, name: "z-active", status: "active" });
    const all = (await callTool(server, "list_routines", {})).content[0].text;
    expect(all.indexOf("z-active")).toBeLessThan(all.indexOf("a-retired")); // active first
    const retired = (await callTool(server, "list_routines", { status: "retired" })).content[0]
      .text;
    expect(retired).toContain("a-retired");
    expect(retired).not.toContain("z-active");
  });

  it("returns the full prompt and lists available names on a miss", async () => {
    const { server } = makeServer();
    await callTool(server, "save_routine", WEEKLY);
    const hit = (await callTool(server, "get_routine", { name: "weekly-review" })).content[0].text;
    expect(hit).toContain("check-in of record");
    expect(hit).toContain("Cadence: weekly, Sunday ~19:00");
    const miss = (await callTool(server, "get_routine", { name: "nope" })).content[0].text;
    expect(miss).toContain("not found");
    expect(miss).toContain("weekly-review");
  });
});

describe("delete_routine", () => {
  it("requires confirm=true and deletes", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_routine", WEEKLY);
    await expect(callTool(server, "delete_routine", { name: "weekly-review" })).rejects.toThrow(); // confirm missing
    const result = await callTool(server, "delete_routine", {
      name: "weekly-review",
      confirm: true,
    });
    expect(result.content[0].text).toContain("deleted");
    expect(db.prepare("SELECT COUNT(*) AS n FROM routines").get()).toEqual({ n: 0 });
    const missing = await callTool(server, "delete_routine", {
      name: "weekly-review",
      confirm: true,
    });
    expect(missing.content[0].text).toContain("not found");
  });
});

describe("routines in search_knowledge (FTS sync)", () => {
  it("finds routine prompts, tracks updates, and forgets deletions", async () => {
    const { server } = makeServer();
    await callTool(server, "save_routine", {
      ...WEEKLY,
      prompt: "Watch the glockenspiel metric weekly.",
    });
    const hit = (await callTool(server, "search_knowledge", { query: "glockenspiel", limit: 5 }))
      .content[0].text;
    expect(hit).toContain("[routine] weekly-review");

    // update: old content drops out of the index, new content matches
    await callTool(server, "save_routine", { ...WEEKLY, prompt: "Now track the theremin metric." });
    const stale = (
      await callTool(server, "search_knowledge", {
        query: "glockenspiel",
        type: "routine",
        limit: 5,
      })
    ).content[0].text;
    expect(stale).toContain("No results");
    const fresh = (
      await callTool(server, "search_knowledge", { query: "theremin", type: "routine", limit: 5 })
    ).content[0].text;
    expect(fresh).toContain("weekly-review");

    await callTool(server, "delete_routine", { name: "weekly-review", confirm: true });
    const gone = (await callTool(server, "search_knowledge", { query: "theremin", limit: 5 }))
      .content[0].text;
    expect(gone).toContain("No results");
  });
});
