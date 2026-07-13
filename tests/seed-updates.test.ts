// coaching-mcp/tests/seed-updates.test.ts
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSchema, openDatabase } from "../src/db.js";
import {
  appliedUpdateId,
  clearSeedUpdatesCache,
  latestUpdateId,
  parseSeedUpdates,
  pendingUpdates,
  setAppliedUpdateId,
} from "../src/seed-updates.js";
import { registerOpsTools } from "../src/tools/ops.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerSeedUpdateTools } from "../src/tools/seed-updates.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type InternalServer = McpServer & {
  _registeredTools: Record<string, RegisteredTool>;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

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

function toolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as InternalServer)._registeredTools);
}

const LEDGER = `# Seed updates

Preface text is ignored.

## 1 — 2026-07-01 — First guidance

- Docs: references/coaching-method
- Apply: auto

Add the new method section verbatim.

## 2 — 2026-07-13 — Conventions bullet

- Docs: SKILL.md

Weave the new convention bullet into the user's conventions section.
`;

const tmpDirs: string[] = [];
function makeSeedDir(ledger?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "coaching-seed-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "SKILL.md"), "# Seeded skill\n\n## 2. Snapshot\n");
  mkdirSync(join(dir, "references"));
  writeFileSync(join(dir, "references", "coaching-method.md"), "method v1");
  if (ledger !== undefined) writeFileSync(join(dir, "UPDATES.md"), ledger);
  return dir;
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  return db;
}

afterEach(() => {
  clearSeedUpdatesCache();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseSeedUpdates", () => {
  it("parses ids, apply levels (default propose), docs, and body", () => {
    const updates = parseSeedUpdates(LEDGER);
    expect(updates.map((u) => u.id)).toEqual([1, 2]);
    expect(updates[0].apply).toBe("auto");
    expect(updates[0].docs).toBe("references/coaching-method");
    expect(updates[0].body).toBe("Add the new method section verbatim.");
    expect(updates[1].apply).toBe("propose");
    expect(updates[0].heading).toContain("First guidance");
  });

  it("skips malformed and duplicate entries with a log line, and sorts by id", () => {
    const logged: string[] = [];
    const updates = parseSeedUpdates(
      "## 2 — b\n\nsecond\n\n## nope — no id\n\nx\n\n## 1 — a\n\nfirst\n\n## 2 — dup\n\ndup",
      (msg) => logged.push(msg),
    );
    expect(updates.map((u) => u.id)).toEqual([1, 2]);
    expect(updates[0].body).toBe("first");
    expect(logged.some((m) => m.includes("without integer id"))).toBe(true);
    expect(logged.some((m) => m.includes("duplicate"))).toBe(true);
  });
});

describe("watermark", () => {
  it("fresh seeding stamps the latest ledger id — nothing pending for new users", () => {
    const seedDir = makeSeedDir(LEDGER);
    const dataDir = mkdtempSync(join(tmpdir(), "coaching-data-"));
    tmpDirs.push(dataDir);
    const db = openDatabase(dataDir, seedDir);
    expect(appliedUpdateId(db)).toBe(2);
    expect(pendingUpdates(db, parseSeedUpdates(LEDGER))).toHaveLength(0);
    db.close();
  });

  it("pre-feature databases (no key) see every entry pending exactly once", () => {
    const db = makeDb();
    const updates = parseSeedUpdates(LEDGER);
    expect(appliedUpdateId(db)).toBe(0);
    expect(pendingUpdates(db, updates).map((u) => u.id)).toEqual([1, 2]);
    setAppliedUpdateId(db, 2);
    expect(pendingUpdates(db, updates)).toHaveLength(0);
  });

  it("watermark beyond the latest id (seed swapped) means nothing pending", () => {
    const db = makeDb();
    setAppliedUpdateId(db, 99);
    expect(pendingUpdates(db, parseSeedUpdates(LEDGER))).toHaveLength(0);
  });
});

describe("get_coaching_context notice", () => {
  it("appears only while updates are pending", async () => {
    const seedDir = makeSeedDir(LEDGER);
    const db = makeDb();
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'personalized skill')").run();
    const server = new McpServer({ name: "t", version: "0" });
    registerReadTools(server, db, undefined, seedDir);
    const before = await callTool(server, "get_coaching_context", {});
    expect(before).toContain("Seed guidance updates pending (2)");
    expect(before).toContain("get_seed_updates");
    setAppliedUpdateId(db, 2);
    const after = await callTool(server, "get_coaching_context", {});
    expect(after).not.toContain("updates pending");
  });

  it("absent without a ledger", async () => {
    const seedDir = makeSeedDir(); // no UPDATES.md
    const db = makeDb();
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'skill')").run();
    const server = new McpServer({ name: "t", version: "0" });
    registerReadTools(server, db, undefined, seedDir);
    expect(await callTool(server, "get_coaching_context", {})).not.toContain("pending");
  });
});

describe("seed-update tools", () => {
  function makeToolServer(ledger?: string): { server: McpServer; db: Database.Database } {
    const seedDir = makeSeedDir(ledger);
    const db = makeDb();
    const server = new McpServer({ name: "t", version: "0" });
    registerSeedUpdateTools(server, db, seedDir);
    registerOpsTools(server, db, undefined, seedDir);
    return { server, db };
  }

  it("dormant without a ledger: tools are not registered", () => {
    const { server } = makeToolServer(undefined);
    expect(toolNames(server)).not.toContain("get_seed_updates");
    expect(toolNames(server)).not.toContain("mark_seed_updates_applied");
  });

  it("get_seed_updates returns preamble + pending entries oldest-first", async () => {
    const { server } = makeToolServer(LEDGER);
    const text = await callTool(server, "get_seed_updates", {});
    expect(text).toContain("Merge each entry below");
    expect(text).toContain("Tiered Auto-Updates");
    expect(text).toContain("## Update #1 — 2026-07-01 — First guidance");
    expect(text).toContain("Apply: auto");
    expect(text).toContain("## Update #2");
    expect(text.indexOf("#1")).toBeLessThan(text.indexOf("#2"));
  });

  it("mark_seed_updates_applied advances the watermark, supports partial application", async () => {
    const { server, db } = makeToolServer(LEDGER);
    const partial = await callTool(server, "mark_seed_updates_applied", { through_id: 1 });
    expect(partial).toContain("through #1");
    expect(partial).toContain("1 update(s) still pending");
    expect(appliedUpdateId(db)).toBe(1);
    const updates = await callTool(server, "get_seed_updates", {});
    expect(updates).not.toContain("## Update #1");
    expect(updates).toContain("## Update #2");
    await callTool(server, "mark_seed_updates_applied", { through_id: 2 });
    expect(await callTool(server, "get_seed_updates", {})).toContain("No seed updates pending");
  });

  it("mark validation: beyond latest errors, at-or-below current is a no-op", async () => {
    const { server, db } = makeToolServer(LEDGER);
    expect(await callTool(server, "mark_seed_updates_applied", { through_id: 3 })).toContain(
      "Error",
    );
    setAppliedUpdateId(db, 2);
    expect(await callTool(server, "mark_seed_updates_applied", { through_id: 1 })).toContain(
      "nothing to do",
    );
    expect(appliedUpdateId(db)).toBe(2);
  });

  it("get_version reports ledger and watermark state", async () => {
    const { server, db } = makeToolServer(LEDGER);
    setAppliedUpdateId(db, 1);
    const info = JSON.parse(await callTool(server, "get_version", {}));
    expect(info.seed_updates_latest).toBe(2);
    expect(info.seed_updates_applied).toBe(1);
  });
});

describe("shipped seed-template ledger", () => {
  it("parses and starts at entry 1", () => {
    const updates = parseSeedUpdates(
      readFileSync(join(process.cwd(), "seed-template", "UPDATES.md"), "utf-8"),
    );
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].id).toBe(1);
    expect(updates[0].apply).toBe("auto");
    expect(latestUpdateId(updates)).toBe(updates.length);
  });
});
