import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  checkWrite,
  DOC_MAX_BYTES,
  ENTRY_MAX_BYTES,
  usageWarning,
  type WriteLimits,
} from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

export function registerWriteTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  const existingLength = (table: "sections" | "refs", name: string): number =>
    (
      db.prepare(`SELECT LENGTH(content) AS n FROM ${table} WHERE name = ?`).get(name) as
        | { n: number }
        | undefined
    )?.n ?? 0;

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
        const refused = checkWrite(db, limits, {
          docBytes: content.length,
          docMax: DOC_MAX_BYTES,
          deltaBytes: content.length - existingLength("sections", name),
        });
        if (refused) return toolError(refused);
        db.prepare(
          "INSERT INTO sections(name, content) VALUES (?, ?)" +
            " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
        ).run(name, content);
        return toolText(`Section '${name}' updated.${usageWarning(db, limits)}`);
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
        const refused = checkWrite(db, limits, {
          docBytes: content.length,
          docMax: DOC_MAX_BYTES,
          deltaBytes: content.length - existingLength("refs", name),
        });
        if (refused) return toolError(refused);
        db.prepare(
          "INSERT INTO refs(name, content) VALUES (?, ?)" +
            " ON CONFLICT(name) DO UPDATE SET content=excluded.content, updated_at=datetime('now')",
        ).run(name, content);
        return toolText(`Reference '${name}' updated.${usageWarning(db, limits)}`);
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
        const refused = checkWrite(db, limits, {
          docBytes: entry.length,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: entry.length,
        });
        if (refused) return toolError(refused);
        const result = db.prepare("INSERT INTO journal(entry) VALUES (?)").run(entry);
        return toolText(
          `Journal entry #${result.lastInsertRowid} saved.${usageWarning(db, limits)}`,
        );
      }),
  );
}
