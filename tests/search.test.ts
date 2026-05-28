// coaching-mcp/tests/search.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeFtsQuery, formatSearchHits, type SearchHit } from "../src/utils/search.js";

describe("sanitizeFtsQuery", () => {
  it("returns plain query unchanged when no special chars", () => {
    expect(sanitizeFtsQuery("calf")).toBe("calf");
  });

  it("wraps parens as phrase", () => {
    expect(sanitizeFtsQuery("Z2(low)")).toBe(`"Z2(low)"`);
  });

  it("wraps colons as phrase", () => {
    expect(sanitizeFtsQuery("name:value")).toBe(`"name:value"`);
  });

  it("wraps slashes as phrase", () => {
    expect(sanitizeFtsQuery("1/2-marathon")).toBe(`"1/2-marathon"`);
  });

  it("wraps caret as phrase", () => {
    expect(sanitizeFtsQuery("path^anchor")).toBe(`"path^anchor"`);
  });

  it("wraps asterisk as phrase", () => {
    expect(sanitizeFtsQuery("foo*bar")).toBe(`"foo*bar"`);
  });

  it("wraps leading minus as phrase", () => {
    expect(sanitizeFtsQuery("-minus")).toBe(`"-minus"`);
  });

  it("trims whitespace before checking", () => {
    expect(sanitizeFtsQuery("  calf  ")).toBe("calf");
  });

  it("escapes internal quotes by doubling", () => {
    expect(sanitizeFtsQuery(`he said "hi"`)).toBe(`"he said ""hi"""`);
  });
});

describe("formatSearchHits", () => {
  it("returns no-results message when hits empty", () => {
    expect(formatSearchHits([], "calf")).toBe("No results found for: calf");
  });

  it("emits per-block header + > snippet for section", () => {
    const hits: SearchHit[] = [
      { type: "section", name: "main", date: "2026-05-25", snippet: "...calf safety..." },
    ];
    const out = formatSearchHits(hits, "calf");
    expect(out).toBe("[section] main (updated 2026-05-25)\n> ...calf safety...");
  });

  it("uses 'created' label for journal entries", () => {
    const hits: SearchHit[] = [
      { type: "journal", name: "#14", date: "2026-05-25", snippet: "session note" },
    ];
    const out = formatSearchHits(hits, "x");
    expect(out).toContain("[journal] #14 (created 2026-05-25)");
  });

  it("joins multiple hits with blank-line separator", () => {
    const hits: SearchHit[] = [
      { type: "section", name: "main", date: "2026-05-25", snippet: "a" },
      { type: "reference", name: "zones", date: "2026-05-25", snippet: "b" },
    ];
    const out = formatSearchHits(hits, "x");
    expect(out).toBe(
      "[section] main (updated 2026-05-25)\n> a\n\n[reference] zones (updated 2026-05-25)\n> b",
    );
  });
});
