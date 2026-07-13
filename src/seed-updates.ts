import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seed-update propagation: seeding runs once per user, so template
 * improvements never reach onboarded users on their own — and mechanical
 * pushes cannot work, because seeded documents are personalized
 * instantiations. Instead the operator maintains `SEED_DIR/UPDATES.md`, a
 * ledger of curated merge instructions written FOR the coaching assistant,
 * which merges them into the user's current documents with judgment and the
 * user's consent (each entry declares Apply: auto|propose against the
 * SKILL.md Tiered Auto-Updates policy).
 *
 * The protocol is self-carrying: all instructions ride in tool outputs
 * (the get_coaching_context pending notice + the get_seed_updates preamble),
 * never in seeded documents — existing users' documents predate the feature
 * and could not bootstrap it.
 *
 * Per-user progress is the `seed_updates_applied` watermark in the user's
 * own meta table, stamped to the latest ledger id at seed time so a freshly
 * onboarded user starts current. No ledger → the feature is dormant.
 */

export type SeedUpdate = {
  id: number;
  /** Full heading after "## ", e.g. "1 — 2026-07-13 — Editing & recovery guidance". */
  heading: string;
  apply: "auto" | "propose";
  docs?: string;
  /** Instruction body for the assistant, metadata lines removed. */
  body: string;
};

/** Ledger cache — SEED_DIR content is immutable for a running process. */
const cache = new Map<string, SeedUpdate[] | null>();

/** Tests only. */
export function clearSeedUpdatesCache(): void {
  cache.clear();
}

/** Returns null when the seed dir has no UPDATES.md (feature dormant). */
export function loadSeedUpdates(seedDir: string, log?: (msg: string) => void): SeedUpdate[] | null {
  const cached = cache.get(seedDir);
  if (cached !== undefined) return cached;
  const path = join(seedDir, "UPDATES.md");
  const parsed = existsSync(path) ? parseSeedUpdates(readFileSync(path, "utf-8"), log) : null;
  cache.set(seedDir, parsed);
  return parsed;
}

/**
 * Forgiving parser: entries are `^## ` sections whose heading starts with an
 * integer id; `- Docs:` / `- Apply:` lines are metadata, the rest is the
 * instruction body. Malformed or duplicate-id entries are skipped with a log
 * line, never a crash.
 */
export function parseSeedUpdates(markdown: string, log?: (msg: string) => void): SeedUpdate[] {
  const updates: SeedUpdate[] = [];
  const seen = new Set<number>();
  for (const chunk of markdown.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf("\n");
    const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const idMatch = /^(\d+)\b/.exec(heading);
    if (!idMatch) {
      log?.(`seed-updates: skipping entry without integer id: "## ${heading}"`);
      continue;
    }
    const id = Number(idMatch[1]);
    if (seen.has(id)) {
      log?.(`seed-updates: skipping duplicate entry id ${id}`);
      continue;
    }
    seen.add(id);
    const rest = nl === -1 ? "" : chunk.slice(nl + 1);
    const apply = /^-\s*Apply:\s*(auto)\s*$/m.test(rest) ? "auto" : "propose";
    const docs = /^-\s*Docs:\s*(.+)$/m.exec(rest)?.[1].trim();
    const body = rest
      .split("\n")
      .filter((line) => !/^-\s*(Apply|Docs):/.test(line))
      .join("\n")
      .trim();
    updates.push({ id, heading, apply, docs, body });
  }
  return updates.sort((a, b) => a.id - b.id);
}

export function latestUpdateId(updates: SeedUpdate[]): number {
  return updates.length > 0 ? updates[updates.length - 1].id : 0;
}

const WATERMARK_KEY = "seed_updates_applied";

/** Missing key (pre-feature DB) reads as 0 → every entry pending exactly once. */
export function appliedUpdateId(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(WATERMARK_KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) || 0 : 0;
}

export function setAppliedUpdateId(db: Database.Database, id: number): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?)" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(WATERMARK_KEY, String(id));
}

/** Watermark above the latest id (operator swapped seeds) → nothing pending. */
export function pendingUpdates(db: Database.Database, updates: SeedUpdate[]): SeedUpdate[] {
  const applied = appliedUpdateId(db);
  return updates.filter((u) => u.id > applied);
}
