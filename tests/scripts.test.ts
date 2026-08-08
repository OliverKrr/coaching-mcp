// coaching-mcp/tests/scripts.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { CHANGES_TABLE_SQL, migrateChangesKindCheck } from "../src/history.js";
import type { WriteLimits } from "../src/quota.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerScriptTools } from "../src/tools/scripts.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
  _registeredTools: ToolMap;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeServer(limits?: WriteLimits): { server: McpServer; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('content_bytes', 0) ON CONFLICT DO NOTHING",
  ).run();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, db);
  registerScriptTools(server, db, limits);
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

const VALID_SCRIPT = {
  name: "weekly-load-chart",
  code: 'import json\n\ndata = json.loads(open("data.json").read())\nprint(len(data))\n',
  description: "Plots weekly load from exported activities.",
};

describe("save_script", () => {
  it("saves valid python and asks for verification", async () => {
    const { server, db } = makeServer();
    const result = await callTool(server, "save_script", VALID_SCRIPT);
    expect(result.content[0].text).toContain("saved");
    expect(result.content[0].text).toContain("mark_script_verified");
    const row = db
      .prepare("SELECT language, verified_at FROM scripts WHERE name = ?")
      .get(VALID_SCRIPT.name) as { language: string; verified_at: string | null };
    expect(row.language).toBe("python");
    expect(row.verified_at).toBeNull();
  });

  it("rejects python that does not parse, saving nothing", async () => {
    const { server, db } = makeServer();
    const result = await callTool(server, "save_script", {
      ...VALID_SCRIPT,
      code: "def broken(:\n    return 1\n",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not parse");
    expect(db.prepare("SELECT COUNT(*) AS n FROM scripts").get()).toEqual({ n: 0 });
  });

  it("returns lint findings as warnings but saves", async () => {
    const { server, db } = makeServer();
    const result = await callTool(server, "save_script", {
      ...VALID_SCRIPT,
      code: "import os\nprint(1)\n",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("F401");
    expect(db.prepare("SELECT COUNT(*) AS n FROM scripts").get()).toEqual({ n: 1 });
  });

  it("skips validation for non-python scripts", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "save_script", {
      name: "helper",
      code: "this is not python (((",
      description: "Not python.",
      language: "other",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("saved");
  });

  it("resets verified_at when code changes, keeps it when unchanged", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    await callTool(server, "mark_script_verified", { name: VALID_SCRIPT.name });
    const verified = db
      .prepare("SELECT verified_at FROM scripts WHERE name = ?")
      .get(VALID_SCRIPT.name) as { verified_at: string | null };
    expect(verified.verified_at).not.toBeNull();

    // Same code, new description → verification survives.
    await callTool(server, "save_script", { ...VALID_SCRIPT, description: "Better wording." });
    const afterMeta = db
      .prepare("SELECT verified_at, description FROM scripts WHERE name = ?")
      .get(VALID_SCRIPT.name) as { verified_at: string | null; description: string };
    expect(afterMeta.verified_at).not.toBeNull();
    expect(afterMeta.description).toBe("Better wording.");

    // Changed code → verification reset.
    await callTool(server, "save_script", { ...VALID_SCRIPT, code: "print(2)\n" });
    const afterCode = db
      .prepare("SELECT verified_at FROM scripts WHERE name = ?")
      .get(VALID_SCRIPT.name) as { verified_at: string | null };
    expect(afterCode.verified_at).toBeNull();
  });

  it("logs an overwrite to change history", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    await callTool(server, "save_script", { ...VALID_SCRIPT, code: "print(42)\n" });
    // logReplace stores a block diff of the previous version, not raw text.
    const change = db
      .prepare("SELECT kind, op, old_text FROM changes WHERE kind = 'script' AND op = 'replace'")
      .get() as { kind: string; op: string; old_text: string };
    expect(change.old_text).toContain("-import json");
    expect(change.old_text).toContain('-data = json.loads(open("data.json").read())');
  });

  it("refuses when the write budget is exhausted", async () => {
    const { server } = makeServer({ quotaBytes: 1024 * 1024, allowWrite: () => false });
    const result = await callTool(server, "save_script", VALID_SCRIPT);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate limit");
  });

  it("counts script bytes toward the quota", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    const bytes = Number(
      (db.prepare("SELECT value FROM meta WHERE key = 'content_bytes'").get() as { value: string })
        .value,
    );
    expect(bytes).toBe(VALID_SCRIPT.code.length + VALID_SCRIPT.description.length);
  });
});

describe("get_script / list_scripts", () => {
  it("round-trips the source verbatim after the marker line", async () => {
    const { server } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    const result = await callTool(server, "get_script", { name: VALID_SCRIPT.name });
    const text = result.content[0].text;
    const source = text.slice(text.indexOf("----- SCRIPT SOURCE -----\n") + 26);
    expect(source).toBe(VALID_SCRIPT.code);
    expect(text).toContain("not verified since last code change");
  });

  it("lists verification state", async () => {
    const { server } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    await callTool(server, "mark_script_verified", { name: VALID_SCRIPT.name });
    const result = await callTool(server, "list_scripts", {});
    expect(result.content[0].text).toContain("weekly-load-chart");
    expect(result.content[0].text).toContain("verified ");
  });

  it("suggests available names on a miss", async () => {
    const { server } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    const result = await callTool(server, "get_script", { name: "nope" });
    expect(result.content[0].text).toContain("weekly-load-chart");
  });
});

describe("delete_script", () => {
  it("deletes and captures the source in change history", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    const result = await callTool(server, "delete_script", {
      name: VALID_SCRIPT.name,
      confirm: true,
    });
    expect(result.content[0].text).toContain("deleted");
    expect(db.prepare("SELECT COUNT(*) AS n FROM scripts").get()).toEqual({ n: 0 });
    const change = db
      .prepare("SELECT old_text FROM changes WHERE kind = 'script' AND op = 'delete'")
      .get() as { old_text: string };
    expect(change.old_text).toContain(VALID_SCRIPT.code);
  });
});

describe("search_knowledge over scripts", () => {
  it("finds scripts by description and code", async () => {
    const { server } = makeServer();
    await callTool(server, "save_script", VALID_SCRIPT);
    const byDescription = await callTool(server, "search_knowledge", { query: "weekly load" });
    expect(byDescription.content[0].text).toContain("[script] weekly-load-chart");
    const byCode = await callTool(server, "search_knowledge", {
      query: "json",
      type: "script",
    });
    expect(byCode.content[0].text).toContain("weekly-load-chart");
  });
});

describe("changes kind CHECK migration", () => {
  it("rebuilds a pre-script changes table and keeps rows, index, and triggers", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    // Simulate a database created before the 'script' kind existed.
    db.exec(`
			CREATE TABLE changes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL CHECK (kind IN ('section','ref','routine','journal')),
				name TEXT NOT NULL,
				op TEXT NOT NULL CHECK (op IN ('edit','replace','delete')),
				old_text TEXT NOT NULL,
				new_text TEXT,
				source TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX changes_doc ON changes(kind, name, id);
		`);
    db.prepare(
      "INSERT INTO changes(kind, name, op, old_text) VALUES ('section', 'main', 'delete', 'old')",
    ).run();
    createSchema(db); // runs migrateChangesKindCheck internally

    // Old row survived, new kind is accepted, index exists.
    expect(db.prepare("SELECT COUNT(*) AS n FROM changes").get()).toEqual({ n: 1 });
    db.prepare(
      "INSERT INTO changes(kind, name, op, old_text) VALUES ('script', 's', 'delete', 'code')",
    ).run();
    const index = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = 'changes_doc'")
      .get();
    expect(index).toEqual({ ok: 1 });

    // The delete-capture triggers on other tables still reach the rebuilt table.
    db.prepare("INSERT INTO sections(name, content) VALUES ('x', 'y')").run();
    db.prepare("DELETE FROM sections WHERE name = 'x'").run();
    const captured = db
      .prepare("SELECT COUNT(*) AS n FROM changes WHERE kind = 'section' AND name = 'x'")
      .get();
    expect(captured).toEqual({ n: 1 });
  });

  it("is idempotent on already-migrated databases", () => {
    const db = new Database(":memory:");
    db.exec(CHANGES_TABLE_SQL);
    const before = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'changes'").get() as { sql: string }
    ).sql;
    migrateChangesKindCheck(db);
    const after = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'changes'").get() as { sql: string }
    ).sql;
    expect(after).toBe(before);
  });
});
