// coaching-mcp/tests/history.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { blockDiff, type ChangeRow, historyBytes, pruneChanges } from "../src/history.js";
import { runRestore } from "../src/restore.js";
import { registerDeleteTools } from "../src/tools/delete.js";
import { registerEditTools } from "../src/tools/edit.js";
import { registerHistoryTools } from "../src/tools/history.js";
import { registerOpsTools } from "../src/tools/ops.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerRoutineTools } from "../src/tools/routines.js";
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
  db.prepare("INSERT INTO meta(key, value) VALUES ('content_bytes', '0')").run();
  db.prepare(
    "INSERT INTO sections(name, content) VALUES ('main', 'line one\nline two\nline three')",
  ).run();
  db.prepare("INSERT INTO refs(name, content) VALUES ('zones', 'Z1: easy\nZ2: steady')").run();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, db);
  registerWriteTools(server, db);
  registerEditTools(server, db);
  registerHistoryTools(server, db);
  registerDeleteTools(server, db);
  registerRoutineTools(server, db);
  registerOpsTools(server, db);
  return { server, db };
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const internal = server as unknown as InternalServer;
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`Tool '${name}' not registered`);
  const validatedArgs = await internal.validateToolInput(tool, args, name);
  const result = await internal.executeToolHandler(tool, validatedArgs, {});
  return result.content[0].text;
}

function changes(db: Database.Database): ChangeRow[] {
  return db.prepare("SELECT * FROM changes ORDER BY id").all() as ChangeRow[];
}

describe("edit_section / edit_reference", () => {
  it("replaces a unique passage and syncs FTS", async () => {
    const { server, db } = makeServer();
    const text = await callTool(server, "edit_section", {
      name: "main",
      old_string: "line two",
      new_string: "unique-edited-marker-zzz",
    });
    expect(text).toContain("1 passage replaced");
    const row = db.prepare("SELECT content FROM sections WHERE name = 'main'").get() as {
      content: string;
    };
    expect(row.content).toBe("line one\nunique-edited-marker-zzz\nline three");
    const hits = await callTool(server, "search_knowledge", {
      query: "unique-edited-marker-zzz",
      limit: 5,
    });
    expect(hits).toContain("unique-edited-marker-zzz");
  });

  it("errors when old_string is not found (stale read)", async () => {
    const { server } = makeServer();
    const text = await callTool(server, "edit_section", {
      name: "main",
      old_string: "not in the document",
      new_string: "x",
    });
    expect(text).toContain("Error");
    expect(text).toContain("Re-read the document");
  });

  it("errors on multiple matches without replace_all, replaces all with it", async () => {
    const { server, db } = makeServer();
    db.prepare("UPDATE sections SET content = 'dup A dup B dup' WHERE name = 'main'").run();
    const refused = await callTool(server, "edit_section", {
      name: "main",
      old_string: "dup",
      new_string: "x",
    });
    expect(refused).toContain("occurs 3 times");
    const text = await callTool(server, "edit_section", {
      name: "main",
      old_string: "dup",
      new_string: "x",
      replace_all: true,
    });
    expect(text).toContain("3 occurrences replaced");
    const row = db.prepare("SELECT content FROM sections WHERE name = 'main'").get() as {
      content: string;
    };
    expect(row.content).toBe("x A x B x");
  });

  it("refuses an edit that would empty the document", async () => {
    const { server } = makeServer();
    const text = await callTool(server, "edit_reference", {
      name: "zones",
      old_string: "Z1: easy\nZ2: steady",
      new_string: "",
    });
    expect(text).toContain("Error");
    expect(text).toContain("delete_reference");
  });

  it("refuses identical old and new strings; reports missing doc", async () => {
    const { server } = makeServer();
    expect(
      await callTool(server, "edit_section", { name: "main", old_string: "a", new_string: "a" }),
    ).toContain("identical");
    expect(
      await callTool(server, "edit_section", { name: "nope", old_string: "a", new_string: "b" }),
    ).toContain("not found");
  });

  it("empty new_string removes the passage (partial removal is allowed)", async () => {
    const { server, db } = makeServer();
    await callTool(server, "edit_section", {
      name: "main",
      old_string: "\nline two",
      new_string: "",
    });
    const row = db.prepare("SELECT content FROM sections WHERE name = 'main'").get() as {
      content: string;
    };
    expect(row.content).toBe("line one\nline three");
  });
});

describe("history capture", () => {
  it("edit logs op=edit with the verbatim strings", async () => {
    const { server, db } = makeServer();
    await callTool(server, "edit_section", {
      name: "main",
      old_string: "line two",
      new_string: "line 2",
    });
    const rows = changes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "section",
      name: "main",
      op: "edit",
      old_text: "line two",
      new_text: "line 2",
      source: "mcp",
    });
  });

  it("update_section on an existing doc logs op=replace with a diff of the previous version", async () => {
    const { server, db } = makeServer();
    await callTool(server, "update_section", {
      name: "main",
      content: "line one\nREWRITTEN\nline three",
    });
    const rows = changes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe("replace");
    expect(rows[0].old_text).toContain("-line two");
    expect(rows[0].old_text).toContain("+REWRITTEN");
    expect(rows[0].new_text).toBeNull();
  });

  it("creates and no-op rewrites log nothing", async () => {
    const { server, db } = makeServer();
    await callTool(server, "update_section", { name: "fresh", content: "new doc" });
    await callTool(server, "update_section", {
      name: "main",
      content: "line one\nline two\nline three",
    });
    expect(changes(db)).toHaveLength(0);
  });

  it("delete_section is captured by trigger with the full old content", async () => {
    const { server, db } = makeServer();
    db.prepare("INSERT INTO sections(name, content) VALUES ('gone', 'precious content')").run();
    await callTool(server, "delete_section", { name: "gone", confirm: true });
    const rows = changes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "section",
      name: "gone",
      op: "delete",
      old_text: "precious content",
      source: null,
    });
  });

  it("direct SQL deletes are captured too (trigger, not code path)", () => {
    const { db } = makeServer();
    db.prepare("DELETE FROM refs WHERE name = 'zones'").run();
    db.prepare("DELETE FROM journal WHERE 1").run(); // no rows — no change rows either
    const rows = changes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ref", name: "zones", op: "delete" });
  });

  it("routine delete records cadence and status alongside the prompt", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_routine", {
      name: "weekly-review",
      cadence: "weekly, Sunday",
      prompt: "Review the week.",
      status: "paused",
    });
    await callTool(server, "delete_routine", { name: "weekly-review", confirm: true });
    const rows = changes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].old_text).toBe("cadence: weekly, Sunday\nstatus: paused\n\nReview the week.");
  });

  it("save_routine logs replace on prompt change, nothing on cadence-only change", async () => {
    const { server, db } = makeServer();
    await callTool(server, "save_routine", { name: "r", cadence: "daily", prompt: "v1" });
    await callTool(server, "save_routine", { name: "r", cadence: "weekly", prompt: "v1" });
    expect(changes(db)).toHaveLength(0);
    await callTool(server, "save_routine", { name: "r", cadence: "weekly", prompt: "v2" });
    const rows = changes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "routine", name: "r", op: "replace" });
  });

  it("journal deletes are captured with the entry id as name", () => {
    const { db } = makeServer();
    const id = db.prepare("INSERT INTO journal(entry) VALUES ('note to keep')").run()
      .lastInsertRowid as number;
    db.prepare("DELETE FROM journal WHERE id = ?").run(id);
    const rows = changes(db);
    expect(rows[0]).toMatchObject({
      kind: "journal",
      name: String(id),
      op: "delete",
      old_text: "note to keep",
    });
  });

  it("history rows do not count against content_bytes", async () => {
    const { server, db } = makeServer();
    const before = db.prepare("SELECT value FROM meta WHERE key = 'content_bytes'").get() as {
      value: string;
    };
    await callTool(server, "edit_section", {
      name: "main",
      old_string: "line two",
      new_string: "line-two", // same length as 'line two'
    });
    const after = db.prepare("SELECT value FROM meta WHERE key = 'content_bytes'").get() as {
      value: string;
    };
    expect(Number(after.value)).toBe(Number(before.value));
    expect(historyBytes(db)).toBeGreaterThan(0);
  });
});

describe("list_changes / get_change", () => {
  it("lists newest first with filters and previews", async () => {
    const { server, db } = makeServer();
    await callTool(server, "edit_section", {
      name: "main",
      old_string: "line two",
      new_string: "line 2",
    });
    db.prepare("DELETE FROM refs WHERE name = 'zones'").run();
    const all = await callTool(server, "list_changes", {});
    expect(all.indexOf("[delete] ref 'zones'")).toBeLessThan(all.indexOf("[edit] section 'main'"));
    const filtered = await callTool(server, "list_changes", { kind: "section", name: "main" });
    expect(filtered).toContain("[edit] section 'main'");
    expect(filtered).not.toContain("zones");
  });

  it("get_change returns full content and a recovery hint per op", async () => {
    const { server, db } = makeServer();
    db.prepare("DELETE FROM refs WHERE name = 'zones'").run();
    const id = (db.prepare("SELECT id FROM changes").get() as { id: number }).id;
    const text = await callTool(server, "get_change", { id });
    expect(text).toContain("Z1: easy\nZ2: steady");
    expect(text).toContain("To restore");
    expect(await callTool(server, "get_change", { id: 9999 })).toContain("not found");
  });

  it("registers no write surface over history", () => {
    const { server } = makeServer();
    const tools = Object.keys((server as unknown as InternalServer)._registeredTools);
    const historyTools = tools.filter((t) => t.includes("change"));
    expect(historyTools.sort()).toEqual(["get_change", "list_changes"]);
  });
});

describe("blockDiff", () => {
  it("trims common prefix/suffix lines", () => {
    expect(blockDiff("a\nb\nc\nd", "a\nX\nY\nd")).toBe(
      "@@ lines 2-3 of 4 (previous version) @@\n-b\n-c\n+X\n+Y",
    );
  });

  it("handles pure insertion", () => {
    expect(blockDiff("a\nb", "a\nNEW\nb")).toBe(
      "@@ inserted after line 1 (previous version had 2 lines) @@\n+NEW",
    );
  });

  it("a full rewrite yields the whole old document", () => {
    const diff = blockDiff("one\ntwo", "totally\ndifferent\nnow");
    expect(diff).toContain("-one");
    expect(diff).toContain("-two");
    expect(diff).toContain("+totally");
  });
});

describe("pruneChanges retention", () => {
  const insert = (db: Database.Database, name: string, createdAt?: string): void => {
    db.prepare(
      "INSERT INTO changes(kind, name, op, old_text, created_at) VALUES ('section', ?, 'delete', 'x', ?)",
    ).run(name, createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
  };

  afterEach(() => {
    delete process.env.HISTORY_MAX_AGE_DAYS;
    delete process.env.HISTORY_MAX_PER_DOC;
    delete process.env.HISTORY_MAX_BYTES;
  });

  it("drops rows past the age cap", () => {
    const { db } = makeServer();
    insert(db, "old", "2000-01-01 00:00:00");
    insert(db, "new");
    pruneChanges(db);
    expect(changes(db).map((r) => r.name)).toEqual(["new"]);
  });

  it("keeps only the newest N per document", () => {
    const { db } = makeServer();
    process.env.HISTORY_MAX_PER_DOC = "2";
    for (let i = 0; i < 5; i++) insert(db, "doc");
    insert(db, "other");
    pruneChanges(db);
    const rows = changes(db);
    expect(rows.filter((r) => r.name === "doc")).toHaveLength(2);
    expect(rows.filter((r) => r.name === "other")).toHaveLength(1);
  });

  it("enforces the global byte backstop, oldest first", () => {
    const { db } = makeServer();
    process.env.HISTORY_MAX_BYTES = "10";
    for (const name of ["a", "b", "c"]) {
      db.prepare(
        "INSERT INTO changes(kind, name, op, old_text) VALUES ('section', ?, 'delete', '12345')",
      ).run(name);
    }
    pruneChanges(db);
    expect(changes(db).map((r) => r.name)).toEqual(["b", "c"]);
  });
});

describe("restore CLI logs its overwrites", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records replace rows with source restore-cli, creates log nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "coaching-restore-hist-"));
    const dbPath = join(dir, "skill.db");
    const db = new Database(dbPath);
    createSchema(db);
    db.prepare("INSERT INTO meta(key, value) VALUES ('content_bytes', '0')").run();
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'live content')").run();
    db.close();

    const seedDir = join(dir, "seed");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, "SKILL.md"), "seeded content");

    const result = runRestore({ db: dbPath, seedDir });
    expect(result.wrote).toBe(true);
    expect(result.changed).toEqual(["main"]);

    const check = new Database(dbPath, { readonly: true });
    const rows = check.prepare("SELECT * FROM changes").all() as ChangeRow[];
    check.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "section", name: "main", op: "replace" });
    expect(rows[0].source).toBe("restore-cli");
    expect(rows[0].old_text).toContain("-live content");
  });
});
