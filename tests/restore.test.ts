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
  manifest?: {
    snapshot_at?: string;
    sections?: Record<string, string>;
    refs?: Record<string, string>;
  };
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
  if (opts.manifest) {
    writeFileSync(
      join(dir, "seed-manifest.json"),
      JSON.stringify({
        snapshot_at: "2026-01-01 00:00:00",
        sections: {},
        refs: {},
        ...opts.manifest,
      }),
      "utf8",
    );
  }
  return dir;
}

/** Force a specific `updated_at` on a live doc so the timestamp guard is deterministic. */
function setUpdatedAt(dbPath: string, table: "sections" | "refs", name: string, ts: string): void {
  const db = new Database(dbPath);
  db.prepare(`UPDATE ${table} SET updated_at = ? WHERE name = ?`).run(ts, name);
  db.close();
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

  it("dry-run reports the same created/changed/unchanged plan a real run would", () => {
    const db = makeDb();
    const seed = makeSeedDir({
      skill: NEW_MAIN, // 'main' exists with ORIGINAL_MAIN → changed
      refs: { squat: "Squat cues", deadlift: "new ref" }, // squat identical → unchanged; deadlift new → created
    });

    const result = runRestore({ db, seedDir: seed, dryRun: true });

    expect(result.created).toEqual(["deadlift"]);
    expect(result.changed).toEqual(["main"]);
    expect(result.unchanged).toEqual(["squat"]);
  });

  it("dry-run writes nothing — content and updated_at are byte-identical, would-be-created ref absent", () => {
    const db = makeDb();

    const before = new Database(db, { readonly: true });
    const beforeMain = before
      .prepare("SELECT content, updated_at FROM sections WHERE name = 'main'")
      .get() as {
      content: string;
      updated_at: string;
    };
    before.close();

    const seed = makeSeedDir({ skill: NEW_MAIN, refs: { deadlift: "new ref" } });
    const result = runRestore({ db, seedDir: seed, dryRun: true });
    expect(result.changed).toContain("main");
    expect(result.created).toContain("deadlift");

    const after = new Database(db, { readonly: true });
    const afterMain = after
      .prepare("SELECT content, updated_at FROM sections WHERE name = 'main'")
      .get() as {
      content: string;
      updated_at: string;
    };
    // No upsert: original content and updated_at are byte-identical.
    expect(afterMain.content).toBe(beforeMain.content);
    expect(afterMain.content).toBe(ORIGINAL_MAIN);
    expect(afterMain.updated_at).toBe(beforeMain.updated_at);
    // The would-be-"created" ref does not exist afterward.
    expect(
      after.prepare("SELECT content FROM refs WHERE name = ?").get("deadlift"),
    ).toBeUndefined();
    after.close();
  });

  it("dry-run works against a read-only-opened DB without error", () => {
    const db = makeDb();
    // Open the DB read-only ourselves and hold it open while the dry-run runs — proving the
    // dry-run path takes no write lock and never attempts a write.
    const holder = new Database(db, { readonly: true });
    const seed = makeSeedDir({ skill: NEW_MAIN, refs: { deadlift: "new ref" } });

    expect(() => runRestore({ db, seedDir: seed, dryRun: true })).not.toThrow();
    const result = runRestore({ db, seedDir: seed, dryRun: true });
    expect(result.changed).toContain("main");

    holder.close();
  });

  describe("clobber guard (seed-manifest.json)", () => {
    it("blocks overwriting a doc whose live updated_at is newer than the seed manifest", () => {
      const db = makeDb();
      setUpdatedAt(db, "sections", "main", "2026-07-01 10:00:00"); // live edited after the seed
      const seed = makeSeedDir({
        skill: NEW_MAIN,
        manifest: { sections: { main: "2026-06-01 10:00:00" } }, // seed captured earlier
      });

      const result = runRestore({ db, seedDir: seed });

      expect(result.conflicts.map((c) => c.name)).toContain("main");
      expect(result.wrote).toBe(false);
      // Live content is untouched — nothing was written.
      const verify = new Database(db, { readonly: true });
      expect(
        (
          verify.prepare("SELECT content FROM sections WHERE name = 'main'").get() as {
            content: string;
          }
        ).content,
      ).toBe(ORIGINAL_MAIN);
      verify.close();
    });

    it("--force overwrites a conflicting doc and reports it as forced", () => {
      const db = makeDb();
      setUpdatedAt(db, "sections", "main", "2026-07-01 10:00:00");
      const seed = makeSeedDir({
        skill: NEW_MAIN,
        manifest: { sections: { main: "2026-06-01 10:00:00" } },
      });

      const result = runRestore({ db, seedDir: seed, force: true });

      expect(result.wrote).toBe(true);
      expect(result.forced).toBe(true);
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

    it("applies a content change when live updated_at is not newer than the seed manifest", () => {
      const db = makeDb();
      setUpdatedAt(db, "sections", "main", "2026-06-01 10:00:00"); // live older than the seed
      const seed = makeSeedDir({
        skill: NEW_MAIN,
        manifest: { sections: { main: "2026-07-01 10:00:00" } }, // seed newer → legit push
      });

      const result = runRestore({ db, seedDir: seed });

      expect(result.changed).toContain("main");
      expect(result.conflicts).toHaveLength(0);
      expect(result.wrote).toBe(true);
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

    it("applies a created doc even when a manifest is present without an entry for it", () => {
      const db = makeDb();
      const seed = makeSeedDir({
        skill: ORIGINAL_MAIN,
        refs: { squat: "Squat cues", deadlift: "brand new" }, // deadlift absent from live
        manifest: {
          sections: { main: "2026-06-01 10:00:00" },
          refs: { squat: "2026-06-01 10:00:00" },
        },
      });

      const result = runRestore({ db, seedDir: seed });

      expect(result.created).toContain("deadlift");
      expect(result.conflicts).toHaveLength(0);
      expect(result.wrote).toBe(true);
    });

    it("treats a to-be-overwritten doc missing from the manifest as a conflict", () => {
      const db = makeDb();
      const seed = makeSeedDir({
        skill: ORIGINAL_MAIN,
        refs: { squat: "Squat cues CHANGED" }, // squat exists in live and content differs
        manifest: { sections: { main: "2026-06-01 10:00:00" }, refs: {} }, // no entry for squat
      });

      const result = runRestore({ db, seedDir: seed });

      expect(result.conflicts.map((c) => c.name)).toContain("squat");
      expect(result.conflicts.find((c) => c.name === "squat")?.seedUpdatedAt).toBeNull();
      expect(result.wrote).toBe(false);
    });

    it("no manifest file → legacy mode: content changes apply and no conflicts are raised", () => {
      const db = makeDb();
      setUpdatedAt(db, "sections", "main", "2026-07-01 10:00:00"); // even if 'newer', legacy ignores it
      const seed = makeSeedDir({ skill: NEW_MAIN }); // no manifest

      const result = runRestore({ db, seedDir: seed });

      expect(result.conflicts).toHaveLength(0);
      expect(result.changed).toContain("main");
      expect(result.wrote).toBe(true);
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

    it("dry-run reports conflicts but writes nothing", () => {
      const db = makeDb();
      setUpdatedAt(db, "sections", "main", "2026-07-01 10:00:00");
      const seed = makeSeedDir({
        skill: NEW_MAIN,
        manifest: { sections: { main: "2026-06-01 10:00:00" } },
      });

      const result = runRestore({ db, seedDir: seed, dryRun: true });

      expect(result.conflicts.map((c) => c.name)).toContain("main");
      expect(result.wrote).toBe(false);
      const verify = new Database(db, { readonly: true });
      expect(
        (
          verify.prepare("SELECT content FROM sections WHERE name = 'main'").get() as {
            content: string;
          }
        ).content,
      ).toBe(ORIGINAL_MAIN);
      verify.close();
    });

    it("throws on a present-but-unparseable manifest instead of silently disabling the guard", () => {
      const db = makeDb();
      const seed = makeSeedDir({ skill: NEW_MAIN });
      writeFileSync(join(seed, "seed-manifest.json"), "{ not valid json", "utf8");

      expect(() => runRestore({ db, seedDir: seed })).toThrow(/manifest/i);
    });
  });
});
