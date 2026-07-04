// coaching-mcp/tests/migrate.test.ts — v1 → v2 layout adoption
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUserByEmail, openAuthDatabase } from "../src/auth/db.js";
import { openDatabase } from "../src/db.js";
import { runMigrate } from "../src/migrate.js";

function makeLegacyLayout(): { dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "migrate-"));
  const seedDir = mkdtempSync(join(tmpdir(), "migrate-seed-"));
  writeFileSync(join(seedDir, "SKILL.md"), "# Legacy Skill\n\nHistoric content.");
  mkdirSync(join(seedDir, "references"));
  writeFileSync(join(seedDir, "references", "zones.md"), "# Legacy zones");
  const db = openDatabase(dataDir, seedDir); // creates + seeds dataDir/skill.db
  db.prepare("INSERT INTO journal (entry) VALUES (?)").run("legacy journal entry");
  db.close();
  return { dataDir };
}

describe("runMigrate", () => {
  it("moves the legacy DB into the per-user layout and registers the user", () => {
    const { dataDir } = makeLegacyLayout();
    const result = runMigrate({ email: "Owner@Example.com", dataDir });

    expect(result.wrote).toBe(true);
    expect(result.userId).toMatch(/^u_[0-9a-f]+$/);
    expect(existsSync(join(dataDir, "skill.db"))).toBe(false);
    const movedDb = join(dataDir, "users", result.userId as string, "skill.db");
    expect(existsSync(movedDb)).toBe(true);

    // content survived, including live-only tables
    const db = openDatabase(join(dataDir, "users", result.userId as string), "/nonexistent");
    const main = db.prepare("SELECT content FROM sections WHERE name='main'").get() as {
      content: string;
    };
    expect(main.content).toContain("Legacy Skill");
    const journal = db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number };
    expect(journal.n).toBe(1);
    db.close();

    // registered with the normalized email, sub linked later at first login
    const authDb = openAuthDatabase(dataDir);
    const user = findUserByEmail(authDb, "owner@example.com");
    expect(user?.id).toBe(result.userId);
    expect(user?.oidc_sub).toBeNull();
    authDb.close();
  });

  it("dry run reports the plan and writes nothing", () => {
    const { dataDir } = makeLegacyLayout();
    const result = runMigrate({ email: "owner@example.com", dataDir, dryRun: true });
    expect(result.wrote).toBe(false);
    expect(result.userId).toBeNull();
    expect(existsSync(join(dataDir, "skill.db"))).toBe(true);
    const authDb = openAuthDatabase(dataDir);
    expect(findUserByEmail(authDb, "owner@example.com")).toBeUndefined();
    authDb.close();
  });

  it("refuses to migrate onto an existing user", () => {
    const { dataDir } = makeLegacyLayout();
    runMigrate({ email: "owner@example.com", dataDir });
    // second legacy DB appears (e.g. restored backup) — must not clobber
    writeFileSync(join(dataDir, "skill.db"), "not a real db");
    expect(() => runMigrate({ email: "owner@example.com", dataDir })).toThrow(/already exists/);
  });

  it("rejects a missing legacy DB and a bad email", () => {
    const empty = mkdtempSync(join(tmpdir(), "migrate-empty-"));
    expect(() => runMigrate({ email: "a@b.c", dataDir: empty })).toThrow(/no legacy database/);
    const { dataDir } = makeLegacyLayout();
    expect(() => runMigrate({ email: "nonsense", dataDir })).toThrow(/not an email/);
  });
});
