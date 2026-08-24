import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSchema } from "../src/db.js";
import { registerReadTools } from "../src/tools/read.js";
import { outlineSection } from "../src/utils/outline.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
  _registeredTools: ToolMap;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeServer(mainContent: string): { server: McpServer; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare("INSERT INTO sections(name, content) VALUES ('main', ?)").run(mainContent);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, db);
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

describe("outlineSection", () => {
  it("attributes bytes to headings, with subtree totals", () => {
    const content = "# Top\naaaa\n## Sub A\nbbbb\n## Sub B\ncccc\n# Second\ndddd";
    const o = outlineSection(content);
    expect(o.totalBytes).toBe(content.length);
    expect(o.preambleBytes).toBe(0);
    expect(o.entries.map((e) => e.text)).toEqual(["Top", "Sub A", "Sub B", "Second"]);
    const top = o.entries[0];
    const subA = o.entries[1];
    const second = o.entries[3];
    // Top's subtree runs to "# Second"; its own bytes stop at "## Sub A".
    expect(top.subtreeBytes).toBe(content.indexOf("# Second"));
    expect(top.ownBytes).toBe(content.indexOf("## Sub A"));
    expect(subA.subtreeBytes).toBe(content.indexOf("## Sub B") - content.indexOf("## Sub A"));
    expect(subA.ownBytes).toBe(subA.subtreeBytes);
    // The last heading owns everything to the end.
    expect(second.subtreeBytes).toBe(content.length - content.indexOf("# Second"));
    // Subtree bytes of top-level headings + preamble cover the whole document.
    expect(top.subtreeBytes + second.subtreeBytes).toBe(content.length);
  });

  it("counts text before the first heading as preamble", () => {
    const o = outlineSection("intro line\n\n# First\nbody");
    expect(o.preambleBytes).toBe("intro line\n\n".length);
    expect(o.entries).toHaveLength(1);
  });

  it("ignores heading-like lines inside code fences", () => {
    const o = outlineSection("# Real\n```\n# not a heading\n```\n## Also real");
    expect(o.entries.map((e) => e.text)).toEqual(["Real", "Also real"]);
  });

  it("handles a document with no headings", () => {
    const o = outlineSection("just prose");
    expect(o.entries).toEqual([]);
    expect(o.preambleBytes).toBe("just prose".length);
  });
});

describe("section_outline", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders per-heading subtree byte counts", async () => {
    const { server } = makeServer("# Title\nbody\n## Zones\nzone table here\n## Rules\nrule text");
    const text = (await callTool(server, "section_outline", {})).content[0].text;
    expect(text).toContain("Outline of 'main'");
    expect(text).toContain("## Zones");
    expect(text).toContain("## Rules");
    expect(text).toMatch(/\d+ B {2}# Title/);
  });

  it("flags 'main' over its index budget", async () => {
    vi.stubEnv("INDEX_BUDGET_BYTES", "10");
    const { server } = makeServer("# Title\nmore than ten bytes of content here");
    const text = (await callTool(server, "section_outline", { name: "main" })).content[0].text;
    expect(text).toContain("OVER by");
  });

  it("reports an unknown section with the available names", async () => {
    const { server } = makeServer("# T\nx");
    const text = (await callTool(server, "section_outline", { name: "nope" })).content[0].text;
    expect(text).toContain("Section 'nope' not found");
    expect(text).toContain("main");
  });
});
