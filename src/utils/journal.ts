// coaching-mcp/src/utils/journal.ts
import type { JournalEntry } from "../db.js";

const HEADLINE_MAX_CHARS = 160;
/** Search hits are snippets already; a long correction is trimmed there only. */
const SEARCH_CORRECTION_MAX_CHARS = 300;

/** Every journal read selects these — the correction and the archive flag
 * travel with the entry on every path, so no renderer can drop them. */
export const JOURNAL_COLUMNS = "id, entry, correction, corrected_at, archived_at, created_at";

/** The correction line. Never truncated: it exists to stop a wrong statement
 * from being read as true, so a clipped one would defeat its own purpose. */
function correctionLine(r: JournalEntry): string {
  if (r.correction === null) return "";
  const when = r.corrected_at ? ` [${r.corrected_at}]` : "";
  return `\n⚠ Correction${when}: ${r.correction}`;
}

/** One compact line per entry: id + timestamp + first line (truncated),
 * with a hint at what was elided so the agent knows a full fetch pays.
 * A correction rides along in full — a headline of a wrong entry without it
 * would be exactly the failure corrections exist to prevent. */
export function journalHeadline(r: JournalEntry): string {
  const lines = r.entry.split("\n");
  const first = lines[0].trim();
  const head = first.length > HEADLINE_MAX_CHARS ? `${first.slice(0, HEADLINE_MAX_CHARS)}…` : first;
  const moreLines = lines.length - 1;
  const suffix = moreLines > 0 ? ` (+${moreLines} more line${moreLines === 1 ? "" : "s"})` : "";
  const archived = r.archived_at !== null ? " [archived]" : "";
  return `#${r.id} [${r.created_at}]${archived} ${head}${suffix}${correctionLine(r)}`;
}

/** Full text, correction attached. */
export function journalFull(r: JournalEntry): string {
  const archived = r.archived_at !== null ? " [archived]" : "";
  return `#${r.id} [${r.created_at}]${archived} ${r.entry}${correctionLine(r)}`;
}

/**
 * The default rendering of a listed entry: full text, except for archived
 * entries, which collapse to a headline. Archiving controls what a session
 * pays for at load time — nothing is lost, `get_journal` with `ids` still
 * returns the entry in full, and `search_knowledge` still indexes it.
 */
export function journalListed(r: JournalEntry): string {
  return r.archived_at !== null ? journalHeadline(r) : journalFull(r);
}

/** Correction text for a search hit, trimmed to snippet length. */
export function correctionSnippet(correction: string): string {
  return correction.length > SEARCH_CORRECTION_MAX_CHARS
    ? `${correction.slice(0, SEARCH_CORRECTION_MAX_CHARS)}…`
    : correction;
}
