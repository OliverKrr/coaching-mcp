import { htmlEscape } from "./http-util.js";

/**
 * Minimal markdown → HTML renderer for the account-page preview.
 *
 * Safe by construction: every text chunk is HTML-escaped BEFORE any tags are
 * generated, so raw HTML/scripts in a document always render as literal text.
 * Link targets are restricted to http(s)/mailto/#/relative. Covers the syntax
 * the coaching documents actually use — headings, bold/italic (asterisk forms
 * only; underscores are left alone so snake_case identifiers don't italicize),
 * inline code, fenced code, lists, tables, blockquotes, rules, links. It is a
 * preview, not a spec-complete markdown engine.
 */
export function renderMarkdown(md: string): string {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  const paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map(inline).join(" ")}</p>`);
    paragraph.length = 0;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    // fenced code block
    if (line.startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).startsWith("```")) {
        code.push(lines[i] as string);
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${htmlEscape(code.join("\n"))}</code></pre>`);
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote (consecutive `>` lines)
    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) {
        quoted.push((lines[i] as string).replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote><p>${quoted.map(inline).join("<br>")}</p></blockquote>`);
      continue;
    }

    // list (consecutive bullet or numbered lines; nesting is flattened)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] as string)) {
        items.push(
          `<li>${inline((lines[i] as string).replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>`,
        );
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // table: a `|` row followed by a separator row of ---/:/| only
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] as string) &&
      (lines[i + 1] as string).includes("-")
    ) {
      flushParagraph();
      const cells = (row: string): string[] =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const header = cells(line)
        .map((c) => `<th>${inline(c)}</th>`)
        .join("");
      i += 2;
      const body: string[] = [];
      while (i < lines.length && (lines[i] as string).includes("|")) {
        body.push(
          `<tr>${cells(lines[i] as string)
            .map((c) => `<td>${inline(c)}</td>`)
            .join("")}</tr>`,
        );
        i++;
      }
      out.push(`<table><tr>${header}</tr>${body.join("")}</table>`);
      continue;
    }

    // blank line ends a paragraph
    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return out.join("\n");
}

/** Inline formatting on ONE escaped line: code spans, links, bold, italic. */
function inline(text: string): string {
  const escaped = htmlEscape(text);
  // Split out code spans first so their contents receive no further formatting.
  return escaped
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return emphasisAndLinks(part);
    })
    .join("");
}

function emphasisAndLinks(escaped: string): string {
  let s = escaped;
  // links — only safe protocols become anchors; anything else stays plain text
  s = s.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_match, label: string, url: string) => {
    if (/^(https?:|mailto:|#|\/)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return label;
  });
  // bold before italic; asterisk forms only (underscores stay literal)
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}
