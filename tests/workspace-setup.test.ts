// coaching-mcp/tests/workspace-setup.test.ts — the Claude Code workspace setup guide: the shipped
// template renders completely, and an MCP client gets it both as the setup_workspace prompt and as
// the coaching://workspace-setup resource.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_URL, VERSION } from "../src/version.js";
import {
  DEFAULT_WORKSPACE_TEMPLATE_DIR,
  loadTemplateFiles,
  registerWorkspaceSetup,
  renderWorkspaceSetup,
  WORKSPACE_SETUP_URI,
} from "../src/workspace-setup.js";

async function connect(templateDir?: string): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" });
  registerWorkspaceSetup(server, templateDir);
  // A tool, so the server also answers tools/list like the real one.
  server.registerTool("noop", { title: "noop" }, () => ({ content: [] }));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientT);
  return client;
}

/** Recovers `path → content` from the appendix, the way an agent reading the guide would. */
function parseAppendix(text: string): Map<string, string> {
  const files = new Map<string, string>();
  const appendix = text.slice(text.indexOf("## Appendix: template files"));
  const re = /^### (\S+)\n\n(`{3,})\n([\s\S]*?)^\2$/gm;
  for (const m of appendix.matchAll(re)) files.set(m[1] as string, m[3] as string);
  return files;
}

describe("workspace template", () => {
  const files = loadTemplateFiles(DEFAULT_WORKSPACE_TEMPLATE_DIR);
  const paths = files.map((f) => f.path);

  it("ships the workspace and host files the guide refers to", () => {
    for (const p of [
      "workspace/CLAUDE.md",
      "workspace/gitignore",
      "workspace/.claude/settings.json",
      "workspace/.claude/skills/capture/SKILL.md",
      "workspace/scripts/run_routine.sh",
      "workspace/scripts/routines/config.env",
      "host/claude-remote-control.service",
      "host/autosave.sh",
      "host/crontab.example",
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths).not.toContain("SETUP.md");
  });

  it("keeps the workspace .claude/settings.json valid JSON", () => {
    const settings = files.find((f) => f.path === "workspace/.claude/settings.json");
    expect(() => JSON.parse(settings?.content ?? "")).not.toThrow();
  });

  it("renders the guide with placeholders filled and every file verbatim", () => {
    const text = renderWorkspaceSetup(DEFAULT_WORKSPACE_TEMPLATE_DIR);
    expect(text).toContain(`version ${VERSION}`);
    expect(text).toContain(`${REPO_URL}/issues`);
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const parsed = parseAppendix(text);
    expect([...parsed.keys()]).toEqual(paths);
    for (const f of files) {
      const expected = f.content.endsWith("\n") || f.content === "" ? f.content : `${f.content}\n`;
      expect(parsed.get(f.path), f.path).toBe(expected);
    }
  });

  it("names only generic hosts and paths", () => {
    const text = renderWorkspaceSetup(DEFAULT_WORKSPACE_TEMPLATE_DIR);
    expect(text).not.toMatch(/raspberrypi\b|\/opt\/|\/home\/(?!user\b)\w+/);
  });
});

describe("setup_workspace over MCP", () => {
  it("serves the guide as a prompt and as a resource", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("setup_workspace");
    const prompt = await client.getPrompt({ name: "setup_workspace" });
    const message = prompt.messages[0];
    expect(message?.role).toBe("user");
    const promptText = message?.content.type === "text" ? message.content.text : "";
    expect(promptText).toContain("# Set up a Claude Code coaching workspace");

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(WORKSPACE_SETUP_URI);
    const read = await client.readResource({ uri: WORKSPACE_SETUP_URI });
    const content = read.contents[0];
    expect(content && "text" in content ? content.text : "").toBe(promptText);
  });

  it("registers nothing when the template dir is missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-template-"));
    const client = await connect(empty);
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
  });

  it("ships the template in the npm package and the Docker build", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(pkg.files).toContain("workspace-template");
    expect(readFileSync("Dockerfile", "utf8")).toContain("COPY workspace-template/");
  });
});
