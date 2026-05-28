// coaching-mcp/src/utils/search.ts
const FTS5_SPECIAL = /["*():/^]/;

export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return trimmed;
  const hasSpecial = FTS5_SPECIAL.test(trimmed) || trimmed.startsWith("-");
  if (!hasSpecial) return trimmed;
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}
