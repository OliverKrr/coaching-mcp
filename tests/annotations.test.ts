// coaching-mcp/tests/annotations.test.ts — every MCP tool must carry the
// metadata clients use to group and gate tools: a human-readable title plus
// MCP tool annotations (readOnlyHint / destructiveHint / openWorldHint).
// Connector UIs bucket tools by these hints — an unannotated tool falls into
// a flat "other tools" group and defaults to the most pessimistic hints.
// This suite fails loudly when a new tool forgets them.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { HevyClient, registerHevyTools } from "../src/integrations/hevy.js";
import { registerDeleteTools } from "../src/tools/delete.js";
import { registerEditTools } from "../src/tools/edit.js";
import { registerHistoryTools } from "../src/tools/history.js";
import { registerOpenItemsTools } from "../src/tools/openitems.js";
import { registerOpsTools } from "../src/tools/ops.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerRoutineTools } from "../src/tools/routines.js";
import { registerSeedUpdateTools } from "../src/tools/seed-updates.js";
import { registerWriteTools } from "../src/tools/write.js";
import { registerTopicTools } from "../src/topics.js";

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};
type RegisteredTool = { title?: string; annotations?: Annotations };
type InternalServer = McpServer & { _registeredTools: Record<string, RegisteredTool> };

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One server with every registerable tool module (per-session serve-mode
 * tools live in mcp-http.ts and are covered by the serve suite instead). */
function registeredTools(): Record<string, RegisteredTool> {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  const seedDir = mkdtempSync(join(tmpdir(), "annotations-seed-"));
  tmpDirs.push(seedDir);
  writeFileSync(join(seedDir, "UPDATES.md"), "## 1 — Initial entry\n\nMerge this.\n");
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, db);
  registerWriteTools(server, db);
  registerEditTools(server, db);
  registerHistoryTools(server, db);
  registerOpsTools(server, db);
  registerDeleteTools(server, db);
  registerOpenItemsTools(server, db);
  registerRoutineTools(server, db);
  registerTopicTools(server, seedDir);
  registerSeedUpdateTools(server, db, seedDir);
  registerHevyTools(server, new HevyClient("test-key"));
  return (server as unknown as InternalServer)._registeredTools;
}

describe("tool metadata", () => {
  const tools = registeredTools();

  it("registers the full tool surface", () => {
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(49);
  });

  it("every tool carries a title and grouping annotations", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.title, `${name}: missing title`).toBeTruthy();
      const a = tool.annotations;
      expect(a, `${name}: missing annotations`).toBeDefined();
      expect(
        a?.readOnlyHint === true || typeof a?.destructiveHint === "boolean",
        `${name}: declares neither readOnlyHint:true nor an explicit destructiveHint`,
      ).toBe(true);
      expect(typeof a?.openWorldHint, `${name}: missing openWorldHint`).toBe("boolean");
    }
  });

  it("read-only tools carry no write hints", () => {
    for (const [name, tool] of Object.entries(tools)) {
      if (tool.annotations?.readOnlyHint !== true) continue;
      expect(
        tool.annotations.destructiveHint,
        `${name}: readOnlyHint with a destructiveHint`,
      ).toBeUndefined();
    }
  });

  it("classifies representative tools correctly", () => {
    expect(tools.get_coaching_context.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(tools.append_journal.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.delete_section.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    // Hevy tools talk to an external API — open world, and full replaces of
    // logged workout data are destructive (Hevy has no change history).
    expect(tools.hevy_get_workouts.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(tools.hevy_update_workout.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});
