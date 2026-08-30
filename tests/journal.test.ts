// coaching-mcp/tests/journal.test.ts — the journal is append-only, and the two
// escape hatches that keeps workable: a correction ATTACHED to an entry (never
// a rewrite) and an archive flag that bounds what session start inlines
// (never a delete). The suite pins the property both features exist for: no
// read path returns a corrected entry as if it still stood, and archiving
// costs nothing in findability.
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema, recomputeContentBytes } from "../src/db.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerSessionTools } from "../src/tools/session.js";
import { registerWriteTools } from "../src/tools/write.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type InternalServer = McpServer & {
  _registeredTools: Record<string, RegisteredTool>;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeServer(): { server: McpServer; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  db.prepare("INSERT INTO sections(name, content) VALUES ('main', ?)").run("Coaching context.");
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReadTools(server, db);
  registerWriteTools(server, db);
  registerSessionTools(server, db);
  return { server, db };
}

async function call(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const internal = server as unknown as InternalServer;
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`Tool '${name}' not registered`);
  const validated = await internal.validateToolInput(tool, args, name);
  const result = await internal.executeToolHandler(tool, validated, {});
  return result.content.map((c) => c.text).join("\n");
}

const WRONG = "Long run 24 km in the Aion 4.\nHR controlled, no calf pain.";
const TRUTH = "Shoe was the Solo 2, not the Aion 4 (Strava gear_id 31635137).";

async function seedCorrectedEntry(server: McpServer): Promise<void> {
  await call(server, "append_journal", { entry: WRONG });
  await call(server, "correct_journal", { entry_id: 1, correction: TRUTH });
}

describe("correct_journal", () => {
  it("attaches the correction without touching the original text", async () => {
    const { server, db } = makeServer();
    await seedCorrectedEntry(server);
    const row = db
      .prepare("SELECT entry, correction, corrected_at FROM journal WHERE id = 1")
      .get() as {
      entry: string;
      correction: string;
      corrected_at: string;
    };
    expect(row.entry).toBe(WRONG);
    expect(row.correction).toBe(TRUTH);
    expect(row.corrected_at).not.toBeNull();
  });

  it("records the correction in the change history", async () => {
    const { server, db } = makeServer();
    await seedCorrectedEntry(server);
    const change = db
      .prepare("SELECT kind, name, op, new_text FROM changes ORDER BY id DESC LIMIT 1")
      .get() as { kind: string; name: string; op: string; new_text: string };
    expect(change).toMatchObject({ kind: "journal", name: "1", op: "edit", new_text: TRUTH });
  });

  it("appends a second correction instead of overwriting the first", async () => {
    const { server } = makeServer();
    await seedCorrectedEntry(server);
    await call(server, "correct_journal", { entry_id: 1, correction: "Distance was 23.4 km." });
    const text = await call(server, "get_journal", { ids: [1] });
    expect(text).toContain(TRUTH);
    expect(text).toContain("Distance was 23.4 km.");
  });

  it("refuses an unknown entry", async () => {
    const { server } = makeServer();
    expect(await call(server, "correct_journal", { entry_id: 99, correction: "x" })).toContain(
      "No journal entry #99",
    );
  });
});

describe("a corrected entry never comes back alone", () => {
  it("carries the correction in get_journal defaults, ids, and headlines", async () => {
    const { server } = makeServer();
    await seedCorrectedEntry(server);
    for (const args of [{}, { ids: [1] }, { format: "headlines" }, { since: "2000-01-01" }]) {
      expect(await call(server, "get_journal", args)).toContain(TRUTH);
    }
  });

  it("carries the correction at session start, in both the full and headline slice", async () => {
    const { server } = makeServer();
    await seedCorrectedEntry(server);
    expect(await call(server, "start_session", {})).toContain(TRUTH);
    expect(
      await call(server, "start_session", { journal_full: 0, journal_headlines: 5 }),
    ).toContain(TRUTH);
  });

  it("carries the correction on a search hit that quotes the wrong statement", async () => {
    const { server } = makeServer();
    await seedCorrectedEntry(server);
    const hits = await call(server, "search_knowledge", { query: "Aion", type: "journal" });
    expect(hits).toContain("⚠ Correction");
    expect(hits).toContain("Solo 2");
  });

  it("makes the correction text itself findable", async () => {
    const { server } = makeServer();
    await seedCorrectedEntry(server);
    const hits = await call(server, "search_knowledge", { query: "31635137", type: "journal" });
    expect(hits).toContain("#1");
  });
});

describe("archive_journal", () => {
  async function seedTwo(server: McpServer): Promise<void> {
    await call(server, "append_journal", { entry: "Old entry.\nSecond line of detail." });
    await call(server, "append_journal", { entry: "Recent entry." });
  }

  it("collapses archived entries to headlines in get_journal and start_session", async () => {
    const { server } = makeServer();
    await seedTwo(server);
    await call(server, "archive_journal", { ids: [1] });
    const listed = await call(server, "get_journal", {});
    expect(listed).toContain("[archived]");
    expect(listed).not.toContain("Second line of detail");
    expect(listed).toContain("Recent entry.");
    const session = await call(server, "start_session", { journal_full: 5 });
    expect(session).not.toContain("Second line of detail");
  });

  it("still returns the full text when asked for by id", async () => {
    const { server } = makeServer();
    await seedTwo(server);
    await call(server, "archive_journal", { ids: [1] });
    expect(await call(server, "get_journal", { ids: [1] })).toContain("Second line of detail");
  });

  it("leaves search untouched", async () => {
    const { server } = makeServer();
    await seedTwo(server);
    const before = await call(server, "search_knowledge", { query: "detail", type: "journal" });
    await call(server, "archive_journal", { ids: [1] });
    const after = await call(server, "search_knowledge", { query: "detail", type: "journal" });
    expect(before).toContain("#1");
    expect(after).toContain("#1");
    expect(after).toContain("archived");
  });

  it("shrinks the session-start payload", async () => {
    const { server } = makeServer();
    await call(server, "append_journal", {
      entry: `Weekly review.\n${"detail line\n".repeat(80)}`,
    });
    const before = (await call(server, "start_session", {})).length;
    await call(server, "archive_journal", { ids: [1] });
    const after = (await call(server, "start_session", {})).length;
    expect(after).toBeLessThan(before / 2);
  });

  it("lifts the flag again with archived: false, and reports unknown ids", async () => {
    const { server } = makeServer();
    await seedTwo(server);
    await call(server, "archive_journal", { ids: [1] });
    const result = await call(server, "archive_journal", { ids: [1, 42], archived: false });
    expect(result).toContain("No entry with id #42");
    expect(await call(server, "get_journal", {})).toContain("Second line of detail");
  });
});

describe("session-start body cap", () => {
  const LONG = `Weekly review headline.\n${"detail ".repeat(400)}`;

  it("caps an inlined entry and names the recovery call", async () => {
    const { server } = makeServer();
    await call(server, "append_journal", { entry: LONG });
    const session = await call(server, "start_session", {});
    expect(session).toContain("get_journal ids:[1] has the full text");
    expect(session.length).toBeLessThan(LONG.length);
    // The cap is mechanical: no curation, no archiving, still bounded.
    expect(await call(server, "get_journal", { ids: [1] })).toContain(LONG.trimEnd());
  });

  it("never truncates the correction of a capped entry", async () => {
    const { server } = makeServer();
    await call(server, "append_journal", { entry: LONG });
    await call(server, "correct_journal", { entry_id: 1, correction: TRUTH });
    const session = await call(server, "start_session", {});
    expect(session).toContain("+");
    expect(session).toContain(TRUTH);
  });

  it("leaves a normal-length entry untouched", async () => {
    const { server } = makeServer();
    await call(server, "append_journal", { entry: "Short entry, nothing elided." });
    const session = await call(server, "start_session", {});
    expect(session).toContain("Short entry, nothing elided.");
    expect(session).not.toContain("has the full text");
  });
});

describe("quota accounting", () => {
  it("counts correction text, and the trigger-kept counter matches the recompute", async () => {
    const { server, db } = makeServer();
    recomputeContentBytes(db); // what openDatabase does before any tool runs
    const bytes = (): number =>
      Number(
        (
          db.prepare("SELECT value FROM meta WHERE key = 'content_bytes'").get() as {
            value: string;
          }
        ).value,
      );
    const before = bytes();
    await seedCorrectedEntry(server);
    expect(bytes()).toBe(before + WRONG.length + TRUTH.length);
    const withTriggers = bytes();
    recomputeContentBytes(db);
    expect(bytes()).toBe(withTriggers);
  });
});

describe("legacy databases", () => {
  /** A journal exactly as it looked before corrections: no columns, a
   * single-column FTS index, and the pre-correction trigger family. */
  function legacyDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
			CREATE TABLE journal (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				entry TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE VIRTUAL TABLE journal_fts USING fts5(entry, content=journal, content_rowid=id);
			CREATE TRIGGER journal_ai AFTER INSERT ON journal BEGIN
				INSERT INTO journal_fts(rowid, entry) VALUES (new.id, new.entry);
			END;
			CREATE TRIGGER journal_ad AFTER DELETE ON journal BEGIN
				INSERT INTO journal_fts(journal_fts, rowid, entry) VALUES ('delete', old.id, old.entry);
			END;
		`);
    db.prepare("INSERT INTO journal(entry) VALUES (?)").run("Legacy entry about tempo runs.");
    return db;
  }

  it("gains the columns and a correction-aware index on the next open", () => {
    const db = legacyDb();
    createSchema(db);
    const cols = (db.pragma("table_info(journal)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["correction", "corrected_at", "archived_at"]));

    // The pre-existing row survived the index rebuild...
    const hit = db
      .prepare("SELECT rowid FROM journal_fts WHERE journal_fts MATCH 'tempo'")
      .get() as { rowid: number } | undefined;
    expect(hit?.rowid).toBe(1);

    // ...and a correction written afterwards is indexed by the new triggers.
    db.prepare("UPDATE journal SET correction = ? WHERE id = 1").run("It was a threshold run.");
    const corrected = db
      .prepare("SELECT rowid FROM journal_fts WHERE journal_fts MATCH 'threshold'")
      .get() as { rowid: number } | undefined;
    expect(corrected?.rowid).toBe(1);
  });

  it("keeps the correction in the delete-capture history record", () => {
    const db = legacyDb();
    createSchema(db);
    db.prepare("UPDATE journal SET correction = ? WHERE id = 1").run("It was a threshold run.");
    db.prepare("DELETE FROM journal WHERE id = 1").run();
    const change = db
      .prepare("SELECT old_text FROM changes WHERE kind = 'journal' AND op = 'delete'")
      .get() as { old_text: string };
    expect(change.old_text).toContain("Legacy entry about tempo runs.");
    expect(change.old_text).toContain("It was a threshold run.");
  });
});
