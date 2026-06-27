// coaching-mcp/tests/restore.test.ts
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { runRestore } from "../src/restore.js";

const ORIGINAL_MAIN = "# Coaching\nold goal";
const NEW_MAIN = "# Coaching\nnew shiny goal";

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "restore-db-"));
  const dbPath = join(dir, "skill.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare("INSERT INTO sections(name, content) VALUES (?, ?)").run("main", ORIGINAL_MAIN);
  db.prepare("INSERT INTO refs(name, content) VALUES (?, ?)").run("squat", "Squat cues");
  db.prepare("INSERT INTO journal(entry, created_at) VALUES (?, ?)").run(
    "existing journal entry",
    "2026-01-01 10:00:00",
  );
  db.prepare(
    "INSERT INTO open_items(kind, content, status) VALUES ('commitment', 'preserve-me', 'open')",
  ).run();
  db.close();
  return dbPath;
}

function makeSeedDir(opts: {
  skill?: string;
  refs?: Record<string, string>;
  sections?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "restore-seed-"));
  if (opts.skill !== undefined) writeFileSync(join(dir, "SKILL.md"), opts.skill, "utf8");
  if (opts.refs) {
    mkdirSync(join(dir, "references"), { recursive: true });
    for (const [name, content] of Object.entries(opts.refs)) {
      writeFileSync(join(dir, "references", `${name}.md`), content, "utf8");
    }
  }
  if (opts.sections) {
    mkdirSync(join(dir, "sections"), { recursive: true });
    for (const [name, content] of Object.entries(opts.sections)) {
      writeFileSync(join(dir, "sections", `${name}.md`), content, "utf8");
    }
  }
  return dir;
}

describe("runRestore", () => {
  it("creates a new reference from the seed dir", () => {
    const db = makeDb();
    const seed = makeSeedDir({
      skill: ORIGINAL_MAIN,
      refs: { squat: "Squat cues", deadlift: "new ref" },
    });

    const result = runRestore({ db, seedDir: seed });

    expect(result.created).toContain("deadlift");
    const verify = new Database(db, { readonly: true });
    expect(
      (
        verify.prepare("SELECT content FROM refs WHERE name = ?").get("deadlift") as {
          content: string;
        }
      ).content,
    ).toBe("new ref");
    verify.close();
  });

  it("overwrites a changed section ('main')", () => {
    const db = makeDb();
    const seed = makeSeedDir({ skill: NEW_MAIN });

    const result = runRestore({ db, seedDir: seed });

    expect(result.changed).toContain("main");
    const verify = new Database(db, { readonly: true });
    expect(
      (
        verify.prepare("SELECT content FROM sections WHERE name = 'main'").get() as {
          content: string;
        }
      ).content,
    ).toBe(NEW_MAIN);
    verify.close();
  });

  it("reports an identical file as unchanged and does not bump updated_at", () => {
    const db = makeDb();
    const before = new Database(db, { readonly: true });
    const originalUpdatedAt = (
      before.prepare("SELECT updated_at FROM sections WHERE name = 'main'").get() as {
        updated_at: string;
      }
    ).updated_at;
    before.close();

    const seed = makeSeedDir({ skill: ORIGINAL_MAIN });
    const result = runRestore({ db, seedDir: seed });

    expect(result.unchanged).toContain("main");
    expect(result.changed).not.toContain("main");
    const verify = new Database(db, { readonly: true });
    expect(
      (
        verify.prepare("SELECT updated_at FROM sections WHERE name = 'main'").get() as {
          updated_at: string;
        }
      ).updated_at,
    ).toBe(originalUpdatedAt);
    verify.close();
  });

  it("leaves pre-existing journal and open_items rows intact", () => {
    const db = makeDb();
    const seed = makeSeedDir({ skill: NEW_MAIN, refs: { deadlift: "new ref" } });

    runRestore({ db, seedDir: seed });

    const verify = new Database(db, { readonly: true });
    expect((verify.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n).toBe(1);
    expect((verify.prepare("SELECT entry FROM journal").get() as { entry: string }).entry).toBe(
      "existing journal entry",
    );
    expect((verify.prepare("SELECT COUNT(*) AS n FROM open_items").get() as { n: number }).n).toBe(
      1,
    );
    expect(
      (verify.prepare("SELECT content FROM open_items").get() as { content: string }).content,
    ).toBe("preserve-me");
    verify.close();
  });

  it("keeps FTS in sync — search finds new content, not the old", () => {
    const db = makeDb();
    const seed = makeSeedDir({ skill: NEW_MAIN });

    runRestore({ db, seedDir: seed });

    const verify = new Database(db, { readonly: true });
    const hits = verify
      .prepare("SELECT name FROM sections_fts WHERE sections_fts MATCH 'shiny'")
      .all() as { name: string }[];
    expect(hits.map((h) => h.name)).toContain("main");
    const stale = verify
      .prepare("SELECT name FROM sections_fts WHERE sections_fts MATCH 'old'")
      .all() as { name: string }[];
    expect(stale).toHaveLength(0);
    verify.close();
  });

  it("throws when the DB file is missing", () => {
    const seed = makeSeedDir({ skill: ORIGINAL_MAIN });
    expect(() => runRestore({ db: "/nonexistent/skill.db", seedDir: seed })).toThrow(/not found/);
  });

  it("throws when the seed dir is missing", () => {
    const db = makeDb();
    expect(() => runRestore({ db, seedDir: "/nonexistent/seed" })).toThrow(/not found/);
  });
});
