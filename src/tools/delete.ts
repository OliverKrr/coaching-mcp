// coaching-mcp/src/tools/delete.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { toolText, withErrorHandling } from "../utils/errors.js";

export function registerDeleteTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "delete_section",
    {
      description:
        "Delete a knowledge section permanently. Requires confirm=true. Cannot delete 'main' (canonical SKILL.md).",
      inputSchema: {
        name: z.string().min(1).describe("Section name to delete"),
        confirm: z.literal(true).describe("Must be true to confirm destructive operation"),
      },
    },
    ({ name }) =>
      withErrorHandling("delete_section", () => {
        if (name === "main") {
          return toolText("Cannot delete 'main' — it's the canonical SKILL.md.");
        }
        const result = db.prepare("DELETE FROM sections WHERE name = ?").run(name);
        if (result.changes === 0) {
          return toolText(`Section '${name}' not found.`);
        }
        return toolText(`Section '${name}' deleted.`);
      }),
  );

  server.registerTool(
    "delete_reference",
    {
      description: "Delete a reference document permanently. Requires confirm=true.",
      inputSchema: {
        name: z.string().min(1).describe("Reference name to delete"),
        confirm: z.literal(true).describe("Must be true to confirm destructive operation"),
      },
    },
    ({ name }) =>
      withErrorHandling("delete_reference", () => {
        const result = db.prepare("DELETE FROM refs WHERE name = ?").run(name);
        if (result.changes === 0) {
          return toolText(`Reference '${name}' not found.`);
        }
        return toolText(`Reference '${name}' deleted.`);
      }),
  );
}
