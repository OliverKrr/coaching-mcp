import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL, VERSION } from "./version.js";

/**
 * The Claude Code workspace setup: an agent-facing guide (workspace-template/SETUP.md) plus the
 * starter files it installs (workspace-template/workspace/ and host/). Served as one markdown
 * document, so an agent on the user's machine needs nothing but its connection to this server:
 *
 * - prompt `setup_workspace` — the user starts it from a client's prompt menu (in Claude Code,
 *   `/mcp__<server>__setup_workspace`);
 * - resource `coaching://workspace-setup` — the same text, readable by an agent on its own when
 *   the user just asks it to set up the workspace.
 *
 * The files ship inside the package, so the guide always matches the server version.
 */
export const DEFAULT_WORKSPACE_TEMPLATE_DIR = fileURLToPath(
  new URL("../workspace-template", import.meta.url),
);

export const WORKSPACE_SETUP_URI = "coaching://workspace-setup";

/** Template subtrees, in appendix order. SETUP.md itself is the guide, not a file to install. */
const TEMPLATE_ROOTS = ["workspace", "host"];

export type TemplateFile = { path: string; content: string };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const full = join(dir, e.name);
      return e.isDirectory() ? walk(full) : e.isFile() ? [full] : [];
    });
}

/** Every installable template file, with its path relative to the template dir (`/`-separated). */
export function loadTemplateFiles(templateDir: string): TemplateFile[] {
  return TEMPLATE_ROOTS.filter((r) => existsSync(join(templateDir, r))).flatMap((root) =>
    walk(join(templateDir, root)).map((full) => ({
      path: relative(templateDir, full).split(sep).join("/"),
      content: readFileSync(full, "utf8"),
    })),
  );
}

/** A code fence longer than any backtick run inside `content`, so nested fences stay literal. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The guide with its placeholders filled, followed by every template file verbatim. */
export function renderWorkspaceSetup(templateDir: string): string {
  const guide = readFileSync(join(templateDir, "SETUP.md"), "utf8")
    .replaceAll("{{VERSION}}", VERSION)
    .replaceAll("{{REPO_URL}}", REPO_URL);
  const files = loadTemplateFiles(templateDir).map((f) => {
    const fence = fenceFor(f.content);
    const body = f.content === "" || f.content.endsWith("\n") ? f.content : `${f.content}\n`;
    return `### ${f.path}\n\n${fence}\n${body}${fence}`;
  });
  return [
    guide.trimEnd(),
    "## Appendix: template files",
    "Each file below is complete; write its content exactly, between the fences. Empty files " +
      "(such as `.gitkeep`) only keep a directory in git.",
    ...files,
  ].join("\n\n");
}

/**
 * Registers the setup prompt and resource. Absent when the template dir is missing (a source
 * checkout without it, or a stripped install), like every configuration-dependent surface.
 */
export function registerWorkspaceSetup(
  server: McpServer,
  templateDir = DEFAULT_WORKSPACE_TEMPLATE_DIR,
): void {
  if (!existsSync(join(templateDir, "SETUP.md"))) return;

  server.registerPrompt(
    "setup_workspace",
    {
      title: "Set up a Claude Code coaching workspace",
      description:
        "Guides Claude Code through setting up a coaching workspace on this machine: a git repo " +
        "for analyses, optionally Remote Control from the phone and scheduled routines from cron.",
    },
    () => ({
      description: "Claude Code coaching workspace setup guide",
      messages: [
        {
          role: "user",
          content: { type: "text", text: renderWorkspaceSetup(templateDir) },
        },
      ],
    }),
  );

  server.registerResource(
    "workspace-setup",
    WORKSPACE_SETUP_URI,
    {
      title: "Claude Code workspace setup guide",
      description:
        "Step-by-step guide plus template files for setting up a Claude Code coaching workspace " +
        "on the user's machine. Read it when the user asks to set up the coaching workspace, " +
        "Remote Control or local routines.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: renderWorkspaceSetup(templateDir) },
      ],
    }),
  );
}
