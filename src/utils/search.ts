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
  type: "section" | "reference" | "journal";
  name: string;
  date: string;
  snippet: string;
};

export function formatSearchHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `No results found for: ${query}`;
  return hits
    .map((h) => {
      const dateLabel = h.type === "journal" ? "created" : "updated";
      return `[${h.type}] ${h.name} (${dateLabel} ${h.date})\n> ${h.snippet}`;
    })
    .join("\n\n");
}
