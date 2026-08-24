import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename, dirname } from "node:path";
import { openDatabase } from "./db.js";
import { registerCoreTools } from "./register.js";
import { VERSION } from "./version.js";

/**
 * `coaching-cli` — local, serverless access to a coaching database for shell
 * use, agents included: no MCP session, no OAuth, no tool definitions in
 * anyone's context. It builds the same McpServer the stdio mode runs and
 * drives it in-process over the SDK's linked in-memory transports, so every
 * write keeps the exact tool semantics (FTS sync, change history, seed
 * handling) — raw SQL against skill.db would silently skip the overwrite
 * diffs, which live in application code, not triggers.
 */

const USAGE = `coaching-cli ${VERSION} — local, no-server access to a coaching knowledge base (skill.db)

Usage: coaching-cli [--db <path>] [--seed <dir>] <command> [args]

  --db <path>    Directory containing skill.db, or the skill.db file itself.
                 Defaults to $DATA_DIR. Created (empty) if missing.
  --seed <dir>   Optional seed dir (SKILL.md + references) for first-run
                 seeding and topic packs. Defaults to $SEED_DIR if set.

Commands:
  tools                  List every tool: name — one-line purpose
  tool <name>            Show one tool's description and JSON input schema
  call <name> [json]     Call a tool; [json] is its arguments object (default {})
  context                Session start (start_session: context + open items + journal)
  search <query> [type]  Full-text search (type: section|reference|journal|routine|script)
  help                   This help

Agent workflow: 'tools' to discover, 'tool <name>' for the schema, 'call' to
execute. Output is the tool's text response. Exit codes: 0 ok, 1 the tool
returned an error, 2 usage error. Writes go through the same handlers as the
MCP server, so change history and search stay intact.`;

type Out = (line: string) => void;

function parseArgs(argv: string[]): {
  dataDir?: string;
  seedDir?: string;
  command?: string;
  rest: string[];
  error?: string;
} {
  let dataDir = process.env.DATA_DIR;
  let seedDir = process.env.SEED_DIR;
  const rest: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (command === undefined && (arg === "--db" || arg === "--seed")) {
      const value = argv[++i];
      if (value === undefined) return { rest, error: `${arg} needs a value` };
      if (arg === "--db") dataDir = value;
      else seedDir = value;
    } else if (command === undefined) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }
  // Accept the skill.db file itself — openDatabase wants its directory.
  if (dataDir !== undefined && basename(dataDir) === "skill.db") dataDir = dirname(dataDir);
  return { dataDir, seedDir, command, rest };
}

export async function runCli(argv: string[], out: Out = console.log): Promise<number> {
  const { dataDir, seedDir, command, rest, error } = parseArgs(argv);
  if (error) {
    out(`Error: ${error}\n\n${USAGE}`);
    return 2;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (dataDir === undefined) {
    out(`Error: no database given — pass --db <path> or set $DATA_DIR.\n\n${USAGE}`);
    return 2;
  }

  // The seed dir is optional for a CLI: without one, a fresh DB starts empty
  // and the pack/ledger tools are absent (they are seed-dir features).
  const db = openDatabase(dataDir, seedDir ?? `${dataDir}/__no-seed__`);
  const server = new McpServer({ name: "coaching-mcp-cli", version: VERSION });
  registerCoreTools(server, db, { seedDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "coaching-cli", version: VERSION });
  await client.connect(clientTransport);

  try {
    switch (command) {
      case "tools": {
        const { tools } = await client.listTools();
        for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
          const summary = (t.description ?? "").split(". ")[0].replace(/\n/g, " ");
          out(`${t.name} — ${summary}`);
        }
        out("");
        out("Details: coaching-cli tool <name>. Execute: coaching-cli call <name> '<json>'.");
        return 0;
      }
      case "tool": {
        const name = rest[0];
        if (!name) {
          out(`Error: tool <name> required.\n\n${USAGE}`);
          return 2;
        }
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          out(`Unknown tool '${name}'. Run 'coaching-cli tools' for the list.`);
          return 1;
        }
        out(`${tool.name}${tool.title ? ` — ${tool.title}` : ""}`);
        out("");
        out(tool.description ?? "(no description)");
        out("");
        out(`Input schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`);
        return 0;
      }
      case "call":
      case "context":
      case "search": {
        let name: string;
        let args: Record<string, unknown>;
        if (command === "context") {
          name = "start_session";
          args = {};
        } else if (command === "search") {
          if (!rest[0]) {
            out(`Error: search <query> required.\n\n${USAGE}`);
            return 2;
          }
          name = "search_knowledge";
          args = { query: rest[0], ...(rest[1] ? { type: rest[1] } : {}) };
        } else {
          if (!rest[0]) {
            out(`Error: call <name> [json] required.\n\n${USAGE}`);
            return 2;
          }
          name = rest[0];
          try {
            args = rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {};
          } catch (err) {
            out(
              `Error: arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            );
            return 2;
          }
        }
        const result = (await client.callTool({ name, arguments: args })) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        const text = (result.content ?? [])
          .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
          .join("\n");
        out(text);
        return result.isError === true ? 1 : 0;
      }
      default:
        out(`Error: unknown command '${command}'.\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    // Protocol-level failure (unknown tool, invalid arguments, …).
    out(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    db.close();
  }
}
