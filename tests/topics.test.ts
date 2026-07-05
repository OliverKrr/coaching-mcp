// coaching-mcp/tests/topics.test.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allRoutineTemplates, loadTopicPacks, registerTopicTools } from "../src/topics.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
  _registeredTools: ToolMap;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

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

function makeSeedDir(): string {
  const seedDir = mkdtempSync(join(tmpdir(), "topics-seed-"));
  const nutrition = join(seedDir, "topics", "nutrition");
  mkdirSync(join(nutrition, "references"), { recursive: true });
  mkdirSync(join(nutrition, "routines"), { recursive: true });
  writeFileSync(
    join(nutrition, "topic.md"),
    "# Nutrition & Meal Planning\n\nEveryday eating with restrictions handled safely.\n\n## Interview\n\n1. Restrictions FIRST.\n",
  );
  writeFileSync(
    join(nutrition, "references", "dietary-profile.md"),
    "# Dietary Profile\n\nHard restrictions table.\n",
  );
  writeFileSync(
    join(nutrition, "routines", "weekly-meal-planning.md"),
    "# Weekly Meal Planning\n\nCadence: weekly, before shopping day\n\nPlan meals, check dietary-profile.\n",
  );
  const custom = join(seedDir, "topics", "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "topic.md"), "# Custom Topic\n\nDefine any topic together.\n");
  // a stray non-pack directory must be ignored
  mkdirSync(join(seedDir, "topics", "not-a-pack"));
  return seedDir;
}

function makeServer(seedDir: string): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTopicTools(server, seedDir);
  return server;
}

describe("topic pack loader", () => {
  it("loads packs sorted with parsed title/description and skips non-packs", () => {
    const packs = loadTopicPacks(makeSeedDir());
    expect(packs.map((p) => p.id)).toEqual(["custom", "nutrition"]);
    const nutrition = packs[1];
    expect(nutrition.title).toBe("Nutrition & Meal Planning");
    expect(nutrition.description).toContain("restrictions handled safely");
    expect(nutrition.references.map((r) => r.name)).toEqual(["dietary-profile"]);
    expect(nutrition.routines[0]).toMatchObject({
      name: "weekly-meal-planning",
      title: "Weekly Meal Planning",
      cadence: "weekly, before shopping day",
    });
  });

  it("returns [] without a topics dir and aggregates routine templates", () => {
    expect(loadTopicPacks(mkdtempSync(join(tmpdir(), "topics-empty-")))).toEqual([]);
    const templates = allRoutineTemplates(makeSeedDir());
    expect(templates).toHaveLength(1);
    expect(templates[0].packId).toBe("nutrition");
  });
});

describe("topic pack tools", () => {
  it("list_topic_packs shows ids, titles, and counts", async () => {
    const server = makeServer(makeSeedDir());
    const text = (await callTool(server, "list_topic_packs", {})).content[0].text;
    expect(text).toContain("**custom** — Custom Topic");
    expect(text).toContain("**nutrition** — Nutrition & Meal Planning");
    expect(text).toContain("1 reference skeletons, 1 routine templates");
  });

  it("list_topic_packs degrades helpfully without packs", async () => {
    const server = makeServer(mkdtempSync(join(tmpdir(), "topics-none-")));
    const text = (await callTool(server, "list_topic_packs", {})).content[0].text;
    expect(text).toContain("No topic packs available");
  });

  it("get_topic_pack assembles instructions, references, and routines", async () => {
    const server = makeServer(makeSeedDir());
    const text = (await callTool(server, "get_topic_pack", { name: "nutrition" })).content[0].text;
    expect(text).toContain("Restrictions FIRST");
    expect(text).toContain("REFERENCE SKELETON `dietary-profile`");
    expect(text).toContain("ROUTINE TEMPLATE `weekly-meal-planning`");
    expect(text).toContain("save_routine");
  });

  it("get_topic_pack lists available packs on a miss", async () => {
    const server = makeServer(makeSeedDir());
    const text = (await callTool(server, "get_topic_pack", { name: "nope" })).content[0].text;
    expect(text).toContain("not found");
    expect(text).toContain("custom, nutrition");
  });
});

describe("shipped seed template", () => {
  it("ships training, nutrition, and custom packs with the expected content", () => {
    const packs = loadTopicPacks(join(import.meta.dirname, "..", "seed-template"));
    expect(packs.map((p) => p.id)).toEqual(["custom", "nutrition", "training"]);
    const training = packs.find((p) => p.id === "training");
    expect(training?.references.map((r) => r.name)).toContain("zones");
    expect(training?.routines.map((r) => r.name)).toEqual([
      "evening-preview",
      "morning-readiness",
      "weekly-review",
    ]);
    const nutrition = packs.find((p) => p.id === "nutrition");
    expect(nutrition?.references.map((r) => r.name)).toEqual([
      "dietary-profile",
      "meal-planning",
      "recipes",
    ]);
    expect(nutrition?.topicMd).toContain("Restrictions FIRST");
  });
});
