// coaching-mcp/tests/db.test.ts
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSchema, seedFromDirectory } from "../src/db.js";
import type { Section, Reference } from "../src/db.js";

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  return db;
}

describe("createSchema", () => {
  it("creates sections, refs, journal tables", () => {
    const db = makeTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("sections");
    expect(names).toContain("refs");
    expect(names).toContain("journal");
  });

  it("creates FTS5 virtual tables", () => {
    const db = makeTestDb();
    const vtables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
      .all() as Array<{ name: string }>;
    expect(vtables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["sections_fts", "refs_fts", "journal_fts"]),
    );
  });
});

describe("seedFromDirectory", () => {
  it("seeds main section and refs from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-seed-"));
    writeFileSync(join(dir, "SKILL.md"), "# Test Skill\n\nSome coaching content here.");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "zones.md"), "# Zones\nZ1: 100–120 bpm");
    writeFileSync(join(dir, "references", "strength.md"), "# Strength\nBack squat");

    const db = makeTestDb();
    seedFromDirectory(db, dir);

    const section = db.prepare("SELECT content FROM sections WHERE name='main'").get() as Section;
    expect(section.content).toContain("Test Skill");

    const zones = db.prepare("SELECT content FROM refs WHERE name='zones'").get() as Reference;
    expect(zones.content).toContain("Z1: 100–120 bpm");
  });

  it("does not re-seed if sections table is non-empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-seed2-"));
    writeFileSync(join(dir, "SKILL.md"), "# New Seed Content");
    const db = makeTestDb();
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'existing')").run();
    seedFromDirectory(db, dir);
    const section = db.prepare("SELECT content FROM sections WHERE name='main'").get() as Section;
    expect(section.content).toBe("existing");
  });
});

describe("FTS5 triggers", () => {
  it("indexes sections on insert", () => {
    const db = makeTestDb();
    db.prepare(
      "INSERT INTO sections(name, content) VALUES ('main', 'calf injury achilles rules')",
    ).run();
    const results = db
      .prepare("SELECT name FROM sections_fts WHERE sections_fts MATCH 'achilles'")
      .all();
    expect(results.length).toBe(1);
  });

  it("re-indexes sections on update", () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'old content here')").run();
    db.prepare("UPDATE sections SET content='new achilles content' WHERE name='main'").run();
    const old = db.prepare("SELECT name FROM sections_fts WHERE sections_fts MATCH 'old'").all();
    expect(old.length).toBe(0);
    const updated = db
      .prepare("SELECT name FROM sections_fts WHERE sections_fts MATCH 'achilles'")
      .all();
    expect(updated.length).toBe(1);
  });

  it("removes section from index on delete", () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO sections(name, content) VALUES ('main', 'calf injury rules')").run();
    db.prepare("DELETE FROM sections WHERE name='main'").run();
    const results = db
      .prepare("SELECT name FROM sections_fts WHERE sections_fts MATCH 'calf'")
      .all();
    expect(results.length).toBe(0);
  });
});

describe("open_items schema", () => {
  it("creates the open_items table with expected columns", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const cols = (db.prepare("PRAGMA table_info(open_items)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      "id",
      "kind",
      "content",
      "status",
      "source",
      "dedup_key",
      "relevant_date",
      "created_at",
      "updated_at",
    ]);
  });

  it("defaults status to 'open'", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.prepare("INSERT INTO open_items(kind, content) VALUES ('flag', 'x')").run();
    const row = db.prepare("SELECT status FROM open_items").get() as { status: string };
    expect(row.status).toBe("open");
  });

  it("rejects an invalid kind via CHECK", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(() =>
      db.prepare("INSERT INTO open_items(kind, content) VALUES ('bogus', 'x')").run(),
    ).toThrow();
  });

  it("rejects an invalid status via CHECK", () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(() =>
      db
        .prepare("INSERT INTO open_items(kind, content, status) VALUES ('flag', 'x', 'bogus')")
        .run(),
    ).toThrow();
  });

  it("has the kind/status index and no open_items FTS table", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='open_items_kind_status'",
      )
      .get();
    expect(idx).toBeTruthy();
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE name='open_items_fts'").get();
    expect(fts).toBeUndefined();
  });
});
