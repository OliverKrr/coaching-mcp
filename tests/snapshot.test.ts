// coaching-mcp/tests/snapshot.test.ts
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchema } from "../src/db.js";
import { runSnapshot } from "../src/snapshot.js";

const MAIN = "# Coaching\nGöäl: lift\tweights\nhere";

function makeSourceDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "snap-src-"));
  const dbPath = join(dir, "skill.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare("INSERT INTO sections(name, content) VALUES (?, ?)").run("main", MAIN);
  db.prepare("INSERT INTO sections(name, content) VALUES (?, ?)").run("nutrition", "Eat well");
  db.prepare("INSERT INTO refs(name, content) VALUES (?, ?)").run("squat", "Squat cues");
  const ins = db.prepare("INSERT INTO journal(entry, created_at) VALUES (?, ?)");
  ins.run("first entry", "2026-01-01 10:00:00");
  ins.run("second entry", "2026-02-01 10:00:00");
  db.close();
  return dbPath;
}

describe("runSnapshot", () => {
  it("writes lossless skill.db + readable markdown incl. journal (full mode)", async () => {
    const src = makeSourceDb();
    const out = mkdtempSync(join(tmpdir(), "snap-out-"));
    await runSnapshot({ db: src, outDir: out });

    expect(readFileSync(join(out, "SKILL.md"), "utf8")).toBe(MAIN);
    expect(readFileSync(join(out, "sections", "nutrition.md"), "utf8")).toBe("Eat well");
    expect(readFileSync(join(out, "references", "squat.md"), "utf8")).toBe("Squat cues");

    const journal = readFileSync(join(out, "journal.md"), "utf8");
    expect(journal.indexOf("second entry")).toBeLessThan(journal.indexOf("first entry"));
    expect(journal).toContain("2026-02-01 10:00:00");

    expect(existsSync(join(out, "skill.db"))).toBe(true);
    const copy = new Database(join(out, "skill.db"), { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM sections").get() as { n: number }).n).toBe(2);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM refs").get() as { n: number }).n).toBe(1);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n).toBe(2);
    copy.close();
  });

  it("--seed-only emits only SKILL.md + references/, nothing else", async () => {
    const src = makeSourceDb();
    const out = mkdtempSync(join(tmpdir(), "snap-seed-"));
    await runSnapshot({ db: src, outDir: out, seedOnly: true });

    expect(existsSync(join(out, "SKILL.md"))).toBe(true);
    expect(existsSync(join(out, "references", "squat.md"))).toBe(true);
    expect(existsSync(join(out, "skill.db"))).toBe(false);
    expect(existsSync(join(out, "journal.md"))).toBe(false);
    expect(existsSync(join(out, "sections"))).toBe(false);
  });

  it("writes open-items.md in full mode and omits it in seed-only", async () => {
    const src = makeSourceDb();
    const db = new Database(src);
    db.prepare(
      "INSERT INTO open_items(kind, content) VALUES ('commitment', 'tue-threshold-marker')",
    ).run();
    db.close();

    const out = mkdtempSync(join(tmpdir(), "snap-oi-"));
    await runSnapshot({ db: src, outDir: out });
    expect(readFileSync(join(out, "open-items.md"), "utf8")).toContain("tue-threshold-marker");

    const seedOut = mkdtempSync(join(tmpdir(), "snap-oi-seed-"));
    await runSnapshot({ db: src, outDir: seedOut, seedOnly: true });
    expect(existsSync(join(seedOut, "open-items.md"))).toBe(false);
  });

  it("writes routines.md in full mode and omits it in seed-only", async () => {
    const src = makeSourceDb();
    const db = new Database(src);
    db.prepare(
      "INSERT INTO routines(name, cadence, prompt, status) VALUES ('weekly-review', 'weekly, Sunday', 'review-prompt-marker', 'paused')",
    ).run();
    db.close();

    const out = mkdtempSync(join(tmpdir(), "snap-rt-"));
    await runSnapshot({ db: src, outDir: out });
    const routines = readFileSync(join(out, "routines.md"), "utf8");
    expect(routines).toContain("weekly-review [paused]");
    expect(routines).toContain("Cadence: weekly, Sunday");
    expect(routines).toContain("review-prompt-marker");

    const seedOut = mkdtempSync(join(tmpdir(), "snap-rt-seed-"));
    await runSnapshot({ db: src, outDir: seedOut, seedOnly: true });
    expect(existsSync(join(seedOut, "routines.md"))).toBe(false);
  });

  it("throws a clear error when the DB file is missing", async () => {
    await expect(runSnapshot({ db: "/nonexistent/skill.db", outDir: tmpdir() })).rejects.toThrow(
      /not found/,
    );
  });

  it("writes seed-manifest.json mapping each emitted doc to its live updated_at (seed-only)", async () => {
    const src = makeSourceDb();
    const before = new Database(src, { readonly: true });
    const mainUpdated = (
      before.prepare("SELECT updated_at FROM sections WHERE name = 'main'").get() as {
        updated_at: string;
      }
    ).updated_at;
    const squatUpdated = (
      before.prepare("SELECT updated_at FROM refs WHERE name = 'squat'").get() as {
        updated_at: string;
      }
    ).updated_at;
    before.close();

    const out = mkdtempSync(join(tmpdir(), "snap-manifest-"));
    await runSnapshot({ db: src, outDir: out, seedOnly: true });

    const manifest = JSON.parse(readFileSync(join(out, "seed-manifest.json"), "utf8"));
    expect(manifest.sections.main).toBe(mainUpdated);
    expect(manifest.refs.squat).toBe(squatUpdated);
    expect(typeof manifest.snapshot_at).toBe("string");
    // seed-only omits non-main sections from both the files and the manifest
    expect(manifest.sections.nutrition).toBeUndefined();
  });

  it("full-mode manifest includes non-main sections too", async () => {
    const src = makeSourceDb();
    const out = mkdtempSync(join(tmpdir(), "snap-manifest-full-"));
    await runSnapshot({ db: src, outDir: out });

    const manifest = JSON.parse(readFileSync(join(out, "seed-manifest.json"), "utf8"));
    expect(manifest.sections.main).toBeDefined();
    expect(manifest.sections.nutrition).toBeDefined();
    expect(manifest.refs.squat).toBeDefined();
  });
});
