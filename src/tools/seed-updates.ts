// coaching-mcp/src/tools/seed-updates.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  appliedUpdateId,
  latestUpdateId,
  loadSeedUpdates,
  pendingUpdates,
  setAppliedUpdateId,
} from "../seed-updates.js";
import { checkWrite, ENTRY_MAX_BYTES, type WriteLimits } from "../quota.js";
import { toolError, toolText, withErrorHandling } from "../utils/errors.js";

/**
 * The merge protocol lives HERE, in the tool outputs — never in seeded
 * documents, which predate the updates they are meant to receive.
 */
const PREAMBLE =
  "The operator updated the seed template this user's documents were originally instantiated " +
  "from. Merge each entry below into the user's CURRENT documents with judgment — their " +
  "documents are personalized, so adapt wording and placement rather than pasting over. Honor " +
  "each entry's Apply level under the user's Tiered Auto-Updates policy: auto = apply " +
  "autonomously and mention it briefly; propose = apply only after the user agrees. Make the " +
  "changes with the normal write tools (edit_*/update_*/save_routine) — every change is " +
  "recorded in change history and recoverable. Afterwards call mark_seed_updates_applied with " +
  "the highest entry id you handled (on partial application, the last fully handled id).";

/** Dormant without a ledger: no UPDATES.md in the seed dir → tools absent. */
export function registerSeedUpdateTools(
  server: McpServer,
  db: Database.Database,
  seedDir: string,
  limits?: WriteLimits,
  log?: (msg: string) => void,
): void {
  const updates = loadSeedUpdates(seedDir, log);
  if (updates === null || updates.length === 0) return;

  server.registerTool(
    "get_seed_updates",
    {
      description:
        "Pending seed-template updates for this user: curated instructions from the operator " +
        "for merging coaching-guidance improvements into the user's personalized documents. " +
        "Call when get_coaching_context reports pending updates; merge per each entry's Apply " +
        "level, then call mark_seed_updates_applied.",
      inputSchema: {},
    },
    () =>
      withErrorHandling("get_seed_updates", () => {
        const pending = pendingUpdates(db, updates);
        if (pending.length === 0) {
          return toolText(
            `No seed updates pending — documents are current (applied through #${appliedUpdateId(db)}, latest is #${latestUpdateId(updates)}).`,
          );
        }
        const entries = pending.map(
          (u) =>
            `## Update #${u.heading}\nApply: ${u.apply}${u.docs ? `\nDocs: ${u.docs}` : ""}\n\n${u.body}`,
        );
        return toolText(`${PREAMBLE}\n\n${entries.join("\n\n")}`);
      }),
  );

  server.registerTool(
    "mark_seed_updates_applied",
    {
      description:
        "Record that seed updates have been merged into this user's documents (or consciously " +
        "settled with the user), so sessions stop re-surfacing them. Pass the highest handled " +
        "entry id; lower than the latest expresses partial application.",
      inputSchema: {
        through_id: z
          .number()
          .int()
          .min(1)
          .describe("Highest seed-update id that has been merged or settled with the user"),
      },
    },
    ({ through_id }) =>
      withErrorHandling("mark_seed_updates_applied", () => {
        const refused = checkWrite(db, limits, {
          docBytes: 0,
          docMax: ENTRY_MAX_BYTES,
          deltaBytes: 0,
        });
        if (refused) return toolError(refused);
        const latest = latestUpdateId(updates);
        const applied = appliedUpdateId(db);
        if (through_id > latest) {
          return toolError(
            `through_id ${through_id} is beyond the latest seed update (#${latest}).`,
          );
        }
        if (through_id <= applied) {
          return toolText(`Already marked applied through #${applied} — nothing to do.`);
        }
        setAppliedUpdateId(db, through_id);
        const remaining = updates.filter((u) => u.id > through_id).length;
        return toolText(
          `Seed updates marked applied through #${through_id}.` +
            (remaining > 0 ? ` ${remaining} update(s) still pending.` : ""),
        );
      }),
  );
}
