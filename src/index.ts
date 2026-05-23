import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

async function main(): Promise<void> {
  const db = openDatabase();
  const server = new McpServer({ name: "skill-mcp", version: "1.0.0" });
  registerReadTools(server, db);
  registerWriteTools(server, db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("skill-mcp: started\n");
  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
