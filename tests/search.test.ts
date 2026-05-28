// coaching-mcp/tests/search.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeFtsQuery } from "../src/utils/search.js";

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
