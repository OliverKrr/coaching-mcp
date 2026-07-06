// coaching-mcp/tests/backup-db.test.ts
import Database from "better-sqlite3";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBackupDb } from "../src/backup-db.js";

function makeWalDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "bk-src-"));
  const dbPath = join(dir, "auth.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)");
  db.exec("CREATE TABLE user_secrets (user_id TEXT, name TEXT, ciphertext BLOB)");
  db.prepare("INSERT INTO users(id, email) VALUES (?, ?)").run("u_abc123", "a@example.com");
  db.prepare("INSERT INTO users(id, email) VALUES (?, ?)").run("u_def456", "b@example.com");
  db.prepare("INSERT INTO user_secrets(user_id, name, ciphertext) VALUES (?, ?, ?)").run(
    "u_abc123",
    "hevy",
    Buffer.from("sealed"),
  );
  // Leave the connection open (rows sit in the -wal file) so the backup path is
  // exercised while writes are uncheckpointed — a plain file copy could miss them.
  db.close();
  return dbPath;
}

describe("runBackupDb", () => {
  it("produces a consistent copy with all rows intact", async () => {
    const src = makeWalDb();
    const out = mkdtempSync(join(tmpdir(), "bk-out-"));
    const dest = join(out, "auth-backup.db");

    const written = await runBackupDb({ src, dest });
    expect(written).toBe(dest);
    expect(existsSync(dest)).toBe(true);

    const copy = new Database(dest, { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM user_secrets").get() as { n: number }).n).toBe(
      1,
    );
    expect(
      (copy.prepare("SELECT email FROM users WHERE id = ?").get("u_def456") as { email: string })
        .email,
    ).toBe("b@example.com");
    copy.close();
  });

  it("overwrites an existing destination file", async () => {
    const src = makeWalDb();
    const out = mkdtempSync(join(tmpdir(), "bk-out2-"));
    const dest = join(out, "auth-backup.db");

    await runBackupDb({ src, dest });
    // A second run must succeed and not append/corrupt.
    await runBackupDb({ src, dest });

    const copy = new Database(dest, { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
    copy.close();
  });

  it("throws when the source DB is missing", async () => {
    const out = mkdtempSync(join(tmpdir(), "bk-out3-"));
    await expect(
      runBackupDb({ src: join(out, "nope.db"), dest: join(out, "x.db") }),
    ).rejects.toThrow(/database not found/);
  });
});
