// coaching-mcp/src/tools/routines.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ROUTINE_STATUSES, type Routine } from "../db.js";
import { logReplace } from "../history.js";
import { checkWrite, ENTRY_MAX_BYTES, usageWarning, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

/**
 * Scheduled routines as per-user documents. The server stores the routine
 * prompt/cadence; the user pastes the prompt into a scheduled task in their
 * own Claude account (the server never initiates conversations, and scheduled
 * tasks cannot be created programmatically from a connector). `status` is
 * bookkeeping maintained in conversation: 'active' = scheduled in Claude,
 * 'paused'/'retired' = not.
 */
export function registerRoutineTools(
  server: McpServer,
  db: Database.Database,
  limits?: WriteLimits,
): void {
  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description:
        "List the user's stored scheduled routines (name, cadence, status). Routines are " +
        "check-in prompts the user runs as scheduled tasks in their own Claude account; the " +
        "stored copy here is the editable source they paste from.",
      inputSchema: {
        status: z.enum(ROUTINE_STATUSES).optional().describe("Filter by status. Omit to list all."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ status }) =>
      withErrorHandling("list_routines", () => {
        const rows = (
          status === undefined
            ? db
                .prepare(
                  "SELECT name, cadence, status, updated_at FROM routines ORDER BY (status != 'active'), name",
                )
                .all()
            : db
                .prepare(
                  "SELECT name, cadence, status, updated_at FROM routines WHERE status = ? ORDER BY name",
                )
                .all(status)
        ) as Array<Pick<Routine, "name" | "cadence" | "status" | "updated_at">>;
        if (rows.length === 0) {
          return toolText(
            `No ${status ?? ""} routines stored yet.`.replace("  ", " ") +
              " To design one, load get_reference('routine-design') and work through it with the user.",
          );
        }
        return toolText(
          rows
            .map((r) => `- **${r.name}** [${r.status}] — ${r.cadence} (updated ${r.updated_at})`)
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "get_routine",
    {
      title: "Get routine",
      description:
        "Get a stored routine by name: cadence, status, and the full prompt text the user " +
        "pastes into their Claude scheduled task.",
      inputSchema: {
        name: z.string().min(1).describe("Routine name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) =>
      withErrorHandling("get_routine", () => {
        const row = db.prepare("SELECT * FROM routines WHERE name = ?").get(name) as
          | Routine
          | undefined;
        if (!row) {
          const available = (
            db.prepare("SELECT name FROM routines ORDER BY name").all() as Array<{ name: string }>
          )
            .map((r) => r.name)
            .join(", ");
          return toolText(`Routine '${name}' not found. Available: ${available || "none"}`);
        }
        return toolText(
          `# ${row.name}\n\nStatus: ${row.status}\nCadence: ${row.cadence}\nUpdated: ${row.updated_at}\n\n## Prompt\n\n${row.prompt}`,
        );
      }),
  );

  server.registerTool(
    "save_routine",
    {
      title: "Save routine",
      description:
        "Create or update a stored routine. Design it first with the user per the " +
        "'routine-design' reference (goal, timeframe, cadence, silence conditions, review point) " +
        "and write the prompt in the user's preferred language. After saving, remind the user to " +
        "create/update the matching scheduled task in their Claude account (the prompt is also " +
        "copyable from their account page).",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(128)
          .describe("Routine name — short kebab-case slug, e.g. 'weekly-review'"),
        cadence: z
          .string()
          .min(1)
          .describe("Human-readable schedule, e.g. 'weekly, Sunday ~19:00'"),
        prompt: z
          .string()
          .min(1)
          .describe("Full prompt for the scheduled task, in the user's preferred language"),
        status: z
          .enum(ROUTINE_STATUSES)
          .optional()
          .describe(
            "'active' once scheduled in Claude, 'paused'/'retired' otherwise. " +
              "Defaults to 'active' for new routines; existing status is kept when omitted.",
          ),
      },
    },
    ({ name, cadence, prompt, status }) =>
      withErrorHandling("save_routine", () => {
        const existing = (
          db.prepare("SELECT prompt FROM routines WHERE name = ?").get(name) as
            | { prompt: string }
            | undefined
        )?.prompt;
        const refused = checkWrite(db, limits, {
          docBytes: prompt.length,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: prompt.length - (existing?.length ?? 0),
        });
        if (refused) return toolError(refused);
        db.transaction(() => {
          db.prepare(
            "INSERT INTO routines(name, cadence, prompt, status) VALUES (?, ?, ?, COALESCE(?, 'active'))" +
              " ON CONFLICT(name) DO UPDATE SET cadence=excluded.cadence, prompt=excluded.prompt," +
              " status=COALESCE(?, routines.status), updated_at=datetime('now')",
          ).run(name, cadence, prompt, status ?? null, status ?? null);
          if (existing !== undefined) logReplace(db, "routine", name, existing, prompt, "mcp");
        })();
        return toolText(
          `Routine '${name}' saved. Remind the user to paste the prompt into a Claude scheduled task (${cadence}) — it is also on their account page under Routines.${usageWarning(db, limits)}`,
        );
      }),
  );

  server.registerTool(
    "delete_routine",
    {
      title: "Delete routine",
      description:
        "Delete a stored routine. Requires confirm=true. Prefer status='retired' via " +
        "save_routine to keep it visible; delete only on explicit user request. The deleted " +
        "routine stays recoverable in change history (list_changes) for a limited retention " +
        "window. The user must remove the matching Claude scheduled task themselves.",
      inputSchema: {
        name: z.string().min(1).describe("Routine name to delete"),
        confirm: z.literal(true).describe("Must be true to confirm destructive operation"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ name }) =>
      withErrorHandling("delete_routine", () => {
        const result = db.prepare("DELETE FROM routines WHERE name = ?").run(name);
        if (result.changes === 0) {
          return toolText(`Routine '${name}' not found.`);
        }
        return toolText(
          `Routine '${name}' deleted. Remind the user to remove the matching scheduled task in their Claude account.`,
        );
      }),
  );
}
