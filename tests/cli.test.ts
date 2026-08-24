import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function collector(): { out: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), text: () => lines.join("\n") };
}

function tempDb(): string {
  return mkdtempSync(join(tmpdir(), "coaching-cli-"));
}

describe("coaching-cli", () => {
  it("prints usage and exits 2 without a command", async () => {
    const { out, text } = collector();
    expect(await runCli([], out)).toBe(2);
    expect(text()).toContain("Usage: coaching-cli");
  });

  it("requires a database location", async () => {
    const { out, text } = collector();
    const prev = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    try {
      expect(await runCli(["tools"], out)).toBe(2);
      expect(text()).toContain("--db");
    } finally {
      if (prev !== undefined) process.env.DATA_DIR = prev;
    }
  });

  it("writes and reads through the real tool handlers", async () => {
    const dir = tempDb();
    const write = collector();
    const code = await runCli(
      [
        "--db",
        dir,
        "call",
        "update_section",
        JSON.stringify({ name: "main", content: "# Plan\nFTP 414W." }),
      ],
      write.out,
    );
    expect(code).toBe(0);
    expect(write.text()).toContain("main");

    const read = collector();
    expect(await runCli(["--db", dir, "context"], read.out)).toBe(0);
    expect(read.text()).toContain("FTP 414W.");
    expect(read.text()).toContain("[hub] main:");

    // An overwrite through the CLI lands in change history like any tool write.
    await runCli(
      [
        "--db",
        dir,
        "call",
        "update_section",
        JSON.stringify({ name: "main", content: "# Plan\nFTP 420W." }),
      ],
      () => {},
    );
    const history = collector();
    expect(await runCli(["--db", dir, "call", "list_changes", "{}"], history.out)).toBe(0);
    expect(history.text()).toContain("main");
  });

  it("accepts the skill.db file path itself", async () => {
    const dir = tempDb();
    await runCli(
      ["--db", dir, "call", "update_section", JSON.stringify({ name: "main", content: "x" })],
      () => {},
    );
    const { out, text } = collector();
    expect(await runCli(["--db", join(dir, "skill.db"), "context"], out)).toBe(0);
    expect(text()).toContain("x");
  });

  it("lists tools and shows a tool's schema", async () => {
    const dir = tempDb();
    const list = collector();
    expect(await runCli(["--db", dir, "tools"], list.out)).toBe(0);
    expect(list.text()).toContain("start_session —");
    expect(list.text()).toContain("record_metric —");

    const schema = collector();
    expect(await runCli(["--db", dir, "tool", "record_metric"], schema.out)).toBe(0);
    expect(schema.text()).toContain("series_kind");
    expect(schema.text()).toContain("Input schema:");
  });

  it("searches via the search shorthand", async () => {
    const dir = tempDb();
    await runCli(
      ["--db", dir, "call", "append_journal", JSON.stringify({ entry: "calf felt fine today" })],
      () => {},
    );
    const { out, text } = collector();
    expect(await runCli(["--db", dir, "search", "calf", "journal"], out)).toBe(0);
    expect(text()).toContain("calf");
  });

  it("exits 1 on an unknown tool and 2 on invalid JSON", async () => {
    const dir = tempDb();
    const unknown = collector();
    expect(await runCli(["--db", dir, "call", "no_such_tool", "{}"], unknown.out)).toBe(1);
    const badJson = collector();
    expect(await runCli(["--db", dir, "call", "get_section", "{not json"], badJson.out)).toBe(2);
    expect(badJson.text()).toContain("not valid JSON");
  });
});
