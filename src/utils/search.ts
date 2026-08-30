// coaching-mcp/src/utils/search.ts
const FTS5_SPECIAL = /["*():/^-]/;

export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return trimmed;
  const hasSpecial = FTS5_SPECIAL.test(trimmed);
  if (!hasSpecial) return trimmed;
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

export type SearchHit = {
  type: "section" | "reference" | "journal" | "routine";
  name: string;
  date: string;
  snippet: string;
  /** Short state marker rendered after the date, e.g. a journal entry's "archived". */
  flag?: string;
  /** A journal entry's correction — a snippet of a corrected entry must never
   * be quoted alone, or the search result restates exactly what was wrong. */
  correction?: string;
};

/** Shared with telemetry's empty-result detection — keep the two in sync. */
export const NO_RESULTS_PREFIX = "No results found for:";

export function formatSearchHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `${NO_RESULTS_PREFIX} ${query}`;
  return hits
    .map((h) => {
      const dateLabel = h.type === "journal" ? "created" : "updated";
      const flag = h.flag ? `, ${h.flag}` : "";
      const correction = h.correction ? `\n> ⚠ Correction: ${h.correction}` : "";
      return `[${h.type}] ${h.name} (${dateLabel} ${h.date}${flag})\n> ${h.snippet}${correction}`;
    })
    .join("\n\n");
}
