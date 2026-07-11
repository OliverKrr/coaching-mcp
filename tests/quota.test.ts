// coaching-mcp/tests/quota.test.ts — the storage-quota machinery in isolation:
// the content_bytes counter (triggers + recompute-on-open), checkWrite's
// refusal ladder, usage warnings, and the per-key rate limiter.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { checkWrite, contentBytes, quotaBytesForUser, usageWarning } from "../src/quota.js";
import { RateLimiter } from "../src/ratelimit.js";

function tempDbDirs(): { dataDir: string; seedDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "quota-data-"));
  const seedDir = mkdtempSync(join(tmpdir(), "quota-seed-"));
  writeFileSync(join(seedDir, "SKILL.md"), "0123456789"); // 10 chars
  mkdirSync(join(seedDir, "references"));
  return { dataDir, seedDir };
}

describe("content_bytes counter", () => {
  it("tracks inserts, updates, and deletes across every content table", () => {
    const { dataDir, seedDir } = tempDbDirs();
    const db = openDatabase(dataDir, seedDir);
    expect(contentBytes(db)).toBe(10); // the seeded SKILL.md

    db.prepare("INSERT INTO refs(name, content) VALUES('r', 'aaaa')").run(); // +4
    db.prepare("INSERT INTO journal(entry) VALUES('bbb')").run(); // +3
    db.prepare("INSERT INTO routines(name, cadence, prompt) VALUES('x', 'weekly', 'ccccc')").run(); // +5
    db.prepare("INSERT INTO open_items(kind, content) VALUES('flag', 'dd')").run(); // +2
    expect(contentBytes(db)).toBe(24);

    db.prepare("UPDATE sections SET content = 'yy' WHERE name = 'main'").run(); // 10 → 2
    expect(contentBytes(db)).toBe(16);

    db.prepare("DELETE FROM refs WHERE name = 'r'").run(); // -4
    db.prepare("DELETE FROM journal").run(); // -3
    expect(contentBytes(db)).toBe(9);
    db.close();
  });

  it("self-heals a drifted counter on reopen", () => {
    const { dataDir, seedDir } = tempDbDirs();
    const db = openDatabase(dataDir, seedDir);
    db.prepare("UPDATE meta SET value = '999999' WHERE key = 'content_bytes'").run();
    db.close();

    const reopened = openDatabase(dataDir, seedDir);
    expect(contentBytes(reopened)).toBe(10);
    reopened.close();
  });

  it("initializes the counter for a pre-quota database missing meta entirely", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "quota-legacy-"));
    const legacy = new Database(join(dataDir, "skill.db"));
    legacy.exec(
      "CREATE TABLE sections (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    legacy.prepare("INSERT INTO sections(name, content) VALUES('main', 'hello')").run();
    legacy.close();

    const db = openDatabase(dataDir, mkdtempSync(join(tmpdir(), "quota-noseed-")));
    expect(contentBytes(db)).toBe(5);
    db.close();
  });
});

describe("checkWrite refusal ladder", () => {
  const { dataDir, seedDir } = tempDbDirs();
  const db = openDatabase(dataDir, seedDir); // usage: 10
  const limits = { quotaBytes: 100, allowWrite: (): boolean => true };

  it("passes small writes and is a no-op without limits", () => {
    expect(checkWrite(db, limits, { docBytes: 20, docMax: 50, deltaBytes: 20 })).toBeUndefined();
    expect(
      checkWrite(db, undefined, { docBytes: 10_000_000, docMax: 50, deltaBytes: 10_000_000 }),
    ).toBeUndefined();
  });

  it("refuses over the per-document cap", () => {
    const msg = checkWrite(db, limits, { docBytes: 60, docMax: 50, deltaBytes: 60 });
    expect(msg).toContain("per-document limit");
  });

  it("refuses growth over the quota but always allows shrinking", () => {
    const grow = checkWrite(db, limits, { docBytes: 95, docMax: 200, deltaBytes: 95 });
    expect(grow).toContain("Storage quota exceeded");
    expect(grow).toContain("request_quota_increase");
    expect(checkWrite(db, limits, { docBytes: 5, docMax: 200, deltaBytes: -100 })).toBeUndefined();
  });

  it("refuses when the write budget is spent", () => {
    const spent = { quotaBytes: 100, allowWrite: (): boolean => false };
    const msg = checkWrite(db, spent, { docBytes: 1, docMax: 50, deltaBytes: 1 });
    expect(msg).toContain("rate limit");
  });

  it("warns from 80% usage, silent below", () => {
    expect(usageWarning(db, { quotaBytes: 100, allowWrite: () => true })).toBe(""); // 10%
    const tight = { quotaBytes: 12, allowWrite: (): boolean => true }; // 10/12 ≈ 83%
    expect(usageWarning(db, tight)).toContain("Storage:");
    expect(usageWarning(db, undefined)).toBe("");
  });
});

describe("quota resolution + per-key rate limiter", () => {
  it("resolves the per-user override over the default", () => {
    expect(quotaBytesForUser({ quota_mb: null }, 50)).toBe(50 * 1024 * 1024);
    expect(quotaBytesForUser({ quota_mb: 200 }, 50)).toBe(200 * 1024 * 1024);
    expect(quotaBytesForUser(undefined, 50)).toBe(50 * 1024 * 1024);
  });

  it("budgets per key with a fixed window", () => {
    const limiter = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allowKey("u_a", t0)).toBe(true);
    expect(limiter.allowKey("u_a", t0)).toBe(true);
    expect(limiter.allowKey("u_a", t0)).toBe(true);
    expect(limiter.allowKey("u_a", t0)).toBe(false); // budget spent
    expect(limiter.allowKey("u_b", t0)).toBe(true); // other keys unaffected
    expect(limiter.allowKey("u_a", t0 + 60_001)).toBe(true); // window rolled
  });
});
