// coaching-mcp/src/utils/journal.ts
import type { JournalEntry } from "../db.js";

const HEADLINE_MAX_CHARS = 160;

/** One compact line per entry: id + timestamp + first line (truncated),
 * with a hint at what was elided so the agent knows a full fetch pays. */
export function journalHeadline(r: JournalEntry): string {
  const lines = r.entry.split("\n");
  const first = lines[0].trim();
  const head = first.length > HEADLINE_MAX_CHARS ? `${first.slice(0, HEADLINE_MAX_CHARS)}…` : first;
  const moreLines = lines.length - 1;
  const suffix = moreLines > 0 ? ` (+${moreLines} more line${moreLines === 1 ? "" : "s"})` : "";
  return `#${r.id} [${r.created_at}] ${head}${suffix}`;
}
