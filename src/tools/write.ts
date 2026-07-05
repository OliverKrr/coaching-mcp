import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { toolText, withErrorHandling } from "../utils/errors.js";

export function registerWriteTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "update_section",
    {
      description:
        "Update or create a coaching knowledge section. Use 'main' for the primary SKILL.md content. Creates the section if it does not exist.",
      inputSchema: {
        name: z.string().min(1).describe("Section name — use 'main' for SKILL.md"),
        content: z.string().min(1).describe("Full replacement content"),
      },
    },
    ({ name, content }) =>
      withErrorHandling("update_section", () => {
        db.prepare(
          "INSERT INTO sections(name, content) VALUES (?, ?)" +
            " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
        ).run(name, content);
        return toolText(`Section '${name}' updated.`);
      }),
  );

  server.registerTool(
    "update_reference",
    {
      description:
        "Update or create a coaching reference document (core ones like patterns/lifestyle, or topic references like zones or recipes).",
      inputSchema: {
        name: z.string().min(1).describe("Reference name without .md extension"),
        content: z.string().min(1).describe("Full replacement content"),
      },
    },
    ({ name, content }) =>
      withErrorHandling("update_reference", () => {
        db.prepare(
          "INSERT INTO refs(name, content) VALUES (?, ?)" +
            " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
        ).run(name, content);
        return toolText(`Reference '${name}' updated.`);
      }),
  );

  server.registerTool(
    "append_journal",
    {
      description:
        "Append a coaching journal entry. The server records the timestamp automatically — do NOT prepend a date to the entry text. Call at the end of every coaching session to log decisions made, data changed, and observations.",
      inputSchema: {
        entry: z.string().min(1).describe("Journal entry text"),
      },
    },
    ({ entry }) =>
      withErrorHandling("append_journal", () => {
        const result = db.prepare("INSERT INTO journal(entry) VALUES (?)").run(entry);
        return toolText(`Journal entry #${result.lastInsertRowid} saved.`);
      }),
  );
}
