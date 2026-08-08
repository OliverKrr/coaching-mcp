// coaching-mcp/src/tools/scripts.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Script } from "../db.js";
import { logReplace } from "../history.js";
import { checkWrite, ENTRY_MAX_BYTES, usageWarning, type WriteLimits } from "../quota.js";
import { checkPython, formatDiagnostics } from "../ruff.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

/**
 * Stored analysis scripts as per-user documents. The server never executes
 * them — the assistant fetches a script, runs it in its own code-execution
 * sandbox against exported data, and reports back. The store's value is
 * consistency across sessions: the same derivation rules next month as today,
 * with every change visible in the change history.
 *
 * Python code is validated with ruff at save time: parse errors reject the
 * save, lint findings come back as warnings. `verified_at` records the last
 * time the assistant confirmed a successful run; any change to the code
 * resets it — a script that looks vetted but never ran is worse than none.
 */

const SCRIPT_LANGUAGES = ["python", "other"] as const;

function scriptBytes(code: string, description: string, requires: string | null): number {
  return code.length + description.length + (requires ?? "").length;
}

function verifiedLabel(row: Pick<Script, "verified_at">): string {
  return row.verified_at
    ? `verified ${row.verified_at} UTC`
    : "not verified since last code change";
}

export function registerScriptTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  server.registerTool(
    "list_scripts",
    {
      title: "List analysis scripts",
      description:
        "List the user's stored analysis scripts (name, description, language, verification " +
        "state). Check here before writing a new analysis from scratch — reusing a verified " +
        "script keeps derivations consistent across sessions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      withErrorHandling("list_scripts", () => {
        const rows = db
          .prepare(
            "SELECT name, description, language, verified_at, updated_at FROM scripts ORDER BY name",
          )
          .all() as Array<
          Pick<Script, "name" | "description" | "language" | "verified_at" | "updated_at">
        >;
        if (rows.length === 0) {
          return toolText(
            "No scripts stored yet. Save reusable analysis code with save_script after it ran successfully.",
          );
        }
        return toolText(
          rows
            .map(
              (r) =>
                `- **${r.name}** (${r.language}) — ${r.description} [${verifiedLabel(r)}; updated ${r.updated_at}]`,
            )
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "get_script",
    {
      title: "Get analysis script",
      description:
        "Get a stored analysis script by name: metadata plus the full source, ready to write " +
        "into the code-execution sandbox verbatim (heredoc). After it runs successfully, call " +
        "mark_script_verified; if you had to change it, save the new version with save_script.",
      inputSchema: {
        name: z.string().min(1).describe("Script name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) =>
      withErrorHandling("get_script", () => {
        const row = db.prepare("SELECT * FROM scripts WHERE name = ?").get(name) as
          | Script
          | undefined;
        if (!row) {
          const available = (
            db.prepare("SELECT name FROM scripts ORDER BY name").all() as Array<{ name: string }>
          )
            .map((r) => r.name)
            .join(", ");
          return toolText(`Script '${name}' not found. Available: ${available || "none"}`);
        }
        const header =
          `# ${row.name} (${row.language})\n` +
          `Description: ${row.description}\n` +
          (row.requires ? `Requires: ${row.requires}\n` : "") +
          `State: ${verifiedLabel(row)}; updated ${row.updated_at} UTC\n` +
          "\nRun it unchanged where possible; after a successful run call " +
          `mark_script_verified('${row.name}'). The source follows after the marker line.\n` +
          "----- SCRIPT SOURCE -----\n";
        return toolText(header + row.code);
      }),
  );

  server.registerTool(
    "save_script",
    {
      title: "Save analysis script",
      description:
        "Create or update a stored analysis script. Python code is validated with ruff: syntax " +
        "errors reject the save, lint findings are returned as warnings. Saving changed code " +
        "resets the verification state — run the script in the sandbox, then call " +
        "mark_script_verified. Keep every displayed number computed inside the script (never " +
        "hand-typed next to it), and keep personal parameter values (thresholds, baselines) in " +
        "the user's documents, passed to the script as inputs.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(128)
          .describe("Script name — short kebab-case slug, e.g. 'weekly-load-chart'"),
        code: z.string().min(1).describe("Full script source"),
        description: z
          .string()
          .min(1)
          .max(500)
          .describe("One or two sentences: what it computes/plots, from which data"),
        language: z.enum(SCRIPT_LANGUAGES).optional().describe("Defaults to python"),
        requires: z
          .string()
          .max(1000)
          .optional()
          .describe(
            'Expected inputs, e.g. "activities.csv from icu_export_activities (fields: …)"',
          ),
      },
    },
    async ({ name, code, description, language, requires }) => {
      try {
        const existing = db.prepare("SELECT * FROM scripts WHERE name = ?").get(name) as
          | Script
          | undefined;
        const lang = language ?? existing?.language ?? "python";

        let validationNote = "";
        if (lang === "python") {
          const check = await checkPython(code);
          if (check === undefined) {
            validationNote = "\n\nNote: ruff validation unavailable — code saved unvalidated.";
          } else if (check.syntaxErrors.length > 0) {
            return toolError(
              `save_script: '${name}' NOT saved — the code does not parse:\n` +
                formatDiagnostics(check.syntaxErrors) +
                "\nFix the syntax and save again.",
            );
          } else if (check.lintWarnings.length > 0) {
            validationNote = `\n\nruff warnings (saved anyway — worth fixing):\n${formatDiagnostics(check.lintWarnings)}`;
          }
        }

        const newBytes = scriptBytes(code, description, requires ?? null);
        const oldBytes = existing
          ? scriptBytes(existing.code, existing.description, existing.requires)
          : 0;
        const refused = checkWrite(db, limits, {
          docBytes: newBytes,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: newBytes - oldBytes,
        });
        if (refused) return toolError(refused);

        const codeChanged = existing !== undefined && existing.code !== code;
        db.transaction(() => {
          db.prepare(
            "INSERT INTO scripts(name, description, language, code, requires) VALUES (?, ?, ?, ?, ?)" +
              " ON CONFLICT(name) DO UPDATE SET description=excluded.description," +
              " language=excluded.language, code=excluded.code, requires=excluded.requires," +
              " verified_at=CASE WHEN scripts.code = excluded.code THEN scripts.verified_at ELSE NULL END," +
              " updated_at=datetime('now')",
          ).run(name, description, lang, code, requires ?? null);
          if (codeChanged) logReplace(db, "script", name, existing.code, code, "mcp");
        })();

        const verifyReminder =
          existing === undefined || codeChanged
            ? " Run it in the sandbox now; on success call mark_script_verified."
            : " Code unchanged — verification state kept.";
        return toolText(
          `Script '${name}' saved.${verifyReminder}${validationNote}${usageWarning(db, limits)}`,
        );
      } catch (err) {
        return toolError(`save_script: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "mark_script_verified",
    {
      title: "Mark script verified",
      description:
        "Record that a stored script just ran successfully in the sandbox (stamps the " +
        "verification time shown by list_scripts/get_script). Call it only after an actual " +
        "successful run in this session — the stamp is the user's signal that the stored " +
        "version can be trusted.",
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        name: z.string().min(1).describe("Script name"),
      },
    },
    ({ name }) =>
      withErrorHandling("mark_script_verified", () => {
        const result = db
          .prepare("UPDATE scripts SET verified_at = datetime('now') WHERE name = ?")
          .run(name);
        if (result.changes === 0) return toolText(`Script '${name}' not found.`);
        return toolText(`Script '${name}' marked verified.`);
      }),
  );

  server.registerTool(
    "delete_script",
    {
      title: "Delete analysis script",
      description:
        "Delete a stored script. Requires confirm=true. The deleted source stays recoverable " +
        "in change history (list_changes) for a limited retention window.",
      inputSchema: {
        name: z.string().min(1).describe("Script name to delete"),
        confirm: z.literal(true).describe("Must be true to confirm destructive operation"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ name }) =>
      withErrorHandling("delete_script", () => {
        const result = db.prepare("DELETE FROM scripts WHERE name = ?").run(name);
        if (result.changes === 0) return toolText(`Script '${name}' not found.`);
        return toolText(`Script '${name}' deleted (recoverable via list_changes for a while).`);
      }),
  );
}
