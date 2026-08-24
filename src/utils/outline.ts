// coaching-mcp/src/utils/outline.ts

/**
 * Heading-level outline of a markdown document with byte attribution, for the
 * "which block should move out of the index" question. `subtreeBytes` is what
 * offloading the block (heading plus everything under it) would actually save;
 * `ownBytes` stops at the next heading of any level. Sizes use string length,
 * matching the LENGTH() semantics the rest of the size reporting uses.
 */

export type OutlineEntry = {
  level: number;
  text: string;
  /** Bytes from this heading to the next heading of any level. */
  ownBytes: number;
  /** Bytes from this heading to the next heading of the same or higher level. */
  subtreeBytes: number;
};

export type Outline = {
  totalBytes: number;
  /** Bytes before the first heading (0 when the document starts with one). */
  preambleBytes: number;
  entries: OutlineEntry[];
};

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```|~~~)/;

export function outlineSection(content: string): Outline {
  const lines = content.split("\n");
  const headings: Array<{ level: number; text: string; offset: number }> = [];
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = HEADING.exec(line);
      if (m) headings.push({ level: m[1].length, text: m[2].trim(), offset });
    }
    offset += line.length + 1;
  }

  const total = content.length;
  const end = (from: number, pred: (level: number) => boolean): number => {
    for (let j = from; j < headings.length; j++) {
      if (pred(headings[j].level)) return headings[j].offset;
    }
    return total;
  };

  return {
    totalBytes: total,
    preambleBytes: headings.length > 0 ? headings[0].offset : total,
    entries: headings.map((h, i) => ({
      level: h.level,
      text: h.text,
      ownBytes: end(i + 1, () => true) - h.offset,
      subtreeBytes: end(i + 1, (level) => level <= h.level) - h.offset,
    })),
  };
}
