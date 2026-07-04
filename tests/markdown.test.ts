// coaching-mcp/tests/markdown.test.ts — preview renderer: correctness of the
// supported subset and, above all, XSS safety by construction.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, and rules", () => {
    const html = renderMarkdown("# Title\n\nSome text\nsame paragraph\n\n---\n\n## Sub");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some text same paragraph</p>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<h2>Sub</h2>");
  });

  it("renders emphasis and inline code, leaving snake_case alone", () => {
    const html = renderMarkdown("**bold** and *ital* plus `dedup_key` and plain_snake_case");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>ital</em>");
    expect(html).toContain("<code>dedup_key</code>");
    expect(html).toContain("plain_snake_case"); // no <em> from underscores
    expect(html).not.toContain("<em>snake</em>");
  });

  it("does not apply formatting inside code spans", () => {
    const html = renderMarkdown("use `**not bold**` here");
    expect(html).toContain("<code>**not bold**</code>");
  });

  it("renders fenced code blocks with escaping", () => {
    const html = renderMarkdown("```\nif (a < b) { run(); }\n**not bold**\n```");
    expect(html).toContain("<pre><code>if (a &lt; b) { run(); }\n**not bold**</code></pre>");
  });

  it("renders lists and blockquotes", () => {
    const html = renderMarkdown("- one\n- two\n\n1. first\n2. second\n\n> quoted\n> lines");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote><p>quoted<br>lines</p></blockquote>");
  });

  it("renders tables", () => {
    const html = renderMarkdown("| Zone | Pace |\n|---|---|\n| Z2 | 5:30 |\n| Z4 | 4:10 |");
    expect(html).toContain("<th>Zone</th>");
    expect(html).toContain("<td>Z2</td>");
    expect(html).toContain("<td>4:10</td>");
  });

  it("linkifies only safe protocols", () => {
    const html = renderMarkdown(
      "[ok](https://example.com/x) and [bad](javascript:x) and [worse](javascript:alert(1)) and [mail](mailto:a@b.c)",
    );
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('href="mailto:a@b.c"');
    // unsafe protocol never becomes an anchor: parseable → label as plain text,
    // unparseable (parens in URL) → the whole thing stays escaped literal text
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("bad");
    expect(html).toContain("[worse](javascript:alert(1))");
  });

  it("escapes raw HTML — script injection renders as literal text", () => {
    const html = renderMarkdown('# Hi <script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes injection attempts inside table cells and headings", () => {
    const html = renderMarkdown('| a |\n|---|\n| <b onmouseover="x()">hi</b> |');
    expect(html).not.toContain("<b onmouseover");
    expect(html).toContain("&lt;b onmouseover=&quot;x()&quot;&gt;hi&lt;/b&gt;");
  });
});
