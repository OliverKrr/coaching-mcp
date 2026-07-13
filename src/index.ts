#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerEditTools } from "./tools/edit.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerOpenItemsTools } from "./tools/openitems.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerReadTools } from "./tools/read.js";
import { registerRoutineTools } from "./tools/routines.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTopicTools } from "./topics.js";
import { SERVER_INSTRUCTIONS, VERSION } from "./version.js";

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} [coaching-mcp] ${msg}\n`);
}

async function main(): Promise<void> {
  log(`booting (node ${process.version}, pid ${process.pid})`);
  log(`DATA_DIR=${process.env.DATA_DIR ?? "(default /data)"}`);
  log(`SEED_DIR=${process.env.SEED_DIR ?? "(default /seed)"}`);

  log("opening database…");
  const db = openDatabase();
  log("database opened");

  log("registering tools…");
  const server = new McpServer(
    { name: "coaching-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerReadTools(server, db);
  registerWriteTools(server, db);
  registerEditTools(server, db);
  registerHistoryTools(server, db);
  registerOpsTools(server, db);
  registerDeleteTools(server, db);
  registerOpenItemsTools(server, db);
  registerRoutineTools(server, db);
  registerTopicTools(server, process.env.SEED_DIR ?? "/seed");
  log("tools registered");

  log("connecting stdio transport…");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready — stdio transport connected");

  process.on("SIGINT", () => {
    log("SIGINT — closing db and exiting");
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("SIGTERM — closing db and exiting");
    db.close();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    log(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log(
      `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    process.exit(1);
  });
}

async function dispatch(): Promise<void> {
  // `coaching-mcp serve` starts the multi-user HTTP mode; the bare command
  // stays the single-user stdio server (v1 behavior).
  if (process.argv[2] === "serve") {
    const serve = await import("./serve.js");
    await serve.main();
    return;
  }
  await main();
}

dispatch().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
