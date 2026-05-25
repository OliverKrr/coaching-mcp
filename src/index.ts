#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

function log(msg: string): void {
  process.stderr.write(`[coaching-mcp] ${msg}\n`);
}

async function main(): Promise<void> {
  log(`booting (node ${process.version}, pid ${process.pid})`);
  log(`DATA_DIR=${process.env.DATA_DIR ?? "(default /data)"}`);
  log(`SEED_DIR=${process.env.SEED_DIR ?? "(default /seed)"}`);

  log("opening database…");
  const db = openDatabase();
  log("database opened");

  log("registering tools…");
  const server = new McpServer({ name: "coaching-mcp", version: "1.0.0" });
  registerReadTools(server, db);
  registerWriteTools(server, db);
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
    log(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    process.exit(1);
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
