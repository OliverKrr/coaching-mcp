import type Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypted per-user secret store (third-party API keys the user connects on
 * the account page). Values are sealed with AES-256-GCM under one server
 * master key (SECRETS_KEY): a leaked auth.db alone yields nothing, and the AAD
 * binds each ciphertext to its (user, name) slot so it cannot be replayed onto
 * another user. Plaintext secrets are never logged and never rendered back.
 */

export function parseSecretsKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  return key;
}

function ensureTable(db: Database.Database): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS user_secrets (
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			ciphertext TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (user_id, name)
		);
	`);
}

export function sealSecret(key: Buffer, userId: string, name: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${userId}:${name}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function openSecret(
  key: Buffer,
  userId: string,
  name: string,
  sealed: string,
): string | undefined {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return undefined;
  try {
    const iv = Buffer.from(parts[1] as string, "base64url");
    const tag = Buffer.from(parts[2] as string, "base64url");
    const ct = Buffer.from(parts[3] as string, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`${userId}:${name}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return undefined; // tampered, wrong key, or replayed onto the wrong slot
  }
}

export function setUserSecret(
  db: Database.Database,
  key: Buffer,
  userId: string,
  name: string,
  plaintext: string,
): void {
  ensureTable(db);
  db.prepare(
    `INSERT INTO user_secrets (user_id, name, ciphertext) VALUES (?, ?, ?)
		 ON CONFLICT(user_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = datetime('now')`,
  ).run(userId, name, sealSecret(key, userId, name, plaintext));
}

export function getUserSecret(
  db: Database.Database,
  key: Buffer,
  userId: string,
  name: string,
): string | undefined {
  ensureTable(db);
  const row = db
    .prepare("SELECT ciphertext FROM user_secrets WHERE user_id = ? AND name = ?")
    .get(userId, name) as { ciphertext: string } | undefined;
  return row ? openSecret(key, userId, name, row.ciphertext) : undefined;
}

export function getUserSecretMeta(
  db: Database.Database,
  userId: string,
  name: string,
): { updated_at: string } | undefined {
  ensureTable(db);
  return db
    .prepare("SELECT updated_at FROM user_secrets WHERE user_id = ? AND name = ?")
    .get(userId, name) as { updated_at: string } | undefined;
}

export function deleteUserSecret(db: Database.Database, userId: string, name: string): void {
  ensureTable(db);
  db.prepare("DELETE FROM user_secrets WHERE user_id = ? AND name = ?").run(userId, name);
}

export function deleteAllUserSecrets(db: Database.Database, userId: string): void {
  ensureTable(db);
  db.prepare("DELETE FROM user_secrets WHERE user_id = ?").run(userId);
}
