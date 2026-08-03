import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { registerSessionTools } from "../src/tools/session.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
  _registeredTools: ToolMap;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeServer(seedDir?: string): { server: McpServer; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare("INSERT INTO sections(name, content) VALUES ('main', ?)").run(
    "Coaching context body. FTP 414W.",
  );
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerSessionTools(server, db, undefined, seedDir);
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

describe("start_session", () => {
  it("returns context, open items and journal in one response", async () => {
    const { server, db } = makeServer();
    db.prepare(
      "INSERT INTO open_items(kind, content) VALUES ('commitment', 'do the long run')",
    ).run();
    db.prepare("INSERT INTO journal(entry) VALUES ('Session note one')").run();
    const text = (await callTool(server, "start_session", {})).content[0].text;
    expect(text).toContain("FTP 414W");
    expect(text).toContain("Open items (1 open)");
    expect(text).toContain("do the long run");
    expect(text).toContain("Session note one");
  });

  it("marks overdue items in the open-items header", async () => {
    const { server, db } = makeServer();
    db.prepare(
      "INSERT INTO open_items(kind, content, relevant_date) VALUES ('commitment', 'past due', '2020-01-01')",
    ).run();
    const text = (await callTool(server, "start_session", {})).content[0].text;
    expect(text).toContain("Open items (1 open, 1 OVERDUE)");
    expect(text).toContain("OVERDUE) past due");
  });

  it("splits journal into newest-full and older-headlines", async () => {
    const { server, db } = makeServer();
    const insert = db.prepare("INSERT INTO journal(entry) VALUES (?)");
    for (let i = 1; i <= 6; i++) insert.run(`entry ${i} first line\nsecond line of ${i}`);
    const text = (
      await callTool(server, "start_session", { journal_full: 2, journal_headlines: 3 })
    ).content[0].text;
    // Newest two in full (with their second lines)…
    expect(text).toContain("second line of 6");
    expect(text).toContain("second line of 5");
    // …older ones only as headlines (first line, no body).
    expect(text).toContain("entry 4 first line");
    expect(text).not.toContain("second line of 4");
    expect(text).toContain("(+1 more line)");
    // And nothing beyond the headline window.
    expect(text).not.toContain("entry 1 first line");
  });

  it("handles an empty database gracefully", async () => {
    const { server } = makeServer();
    const text = (await callTool(server, "start_session", {})).content[0].text;
    expect(text).toContain("No open items.");
    expect(text).toContain("No journal entries yet.");
  });

  it("carries the pending seed-update notice", async () => {
    const seedDir = mkdtempSync(join(tmpdir(), "coaching-seed-"));
    writeFileSync(
      join(seedDir, "UPDATES.md"),
      `# Seed updates

## 1 — 2026-01-01 — Test update

- Apply: auto

Instructions for the assistant.
`,
    );
    const { server } = makeServer(seedDir);
    const text = (await callTool(server, "start_session", {})).content[0].text;
    expect(text).toContain("Seed guidance updates pending (1)");
  });
});
