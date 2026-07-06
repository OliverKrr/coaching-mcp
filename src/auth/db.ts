import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Central auth database (DATA_DIR/auth.db): user registry, DCR clients,
 * in-flight authorization state, opaque token store, account-page sessions.
 *
 * Every secret handed to a client (auth codes, access/refresh tokens) is
 * stored only as a SHA-256 hash; web-session ids are random 256-bit values
 * stored server-side, so possession of the DB alone never yields a usable
 * credential.
 */

export type User = {
  id: string;
  email: string;
  oidc_sub: string | null;
  created_at: string;
  last_login_at: string | null;
};

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export function openAuthDatabase(dataDir: string): Database.Database {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "auth.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			oidc_sub TEXT UNIQUE,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_login_at TEXT
		);
		CREATE TABLE IF NOT EXISTS clients (
			client_id TEXT PRIMARY KEY,
			redirect_uris TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS pending_auth (
			state TEXT PRIMARY KEY,
			payload TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS auth_codes (
			code_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			redirect_uri TEXT NOT NULL,
			code_challenge TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
			token_hash TEXT NOT NULL UNIQUE,
			expires_at INTEGER NOT NULL,
			revoked_at INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_used_at TEXT
		);
		CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
		CREATE TABLE IF NOT EXISTS web_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			csrf TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS gateways (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			url TEXT NOT NULL,
			prefix TEXT NOT NULL DEFAULT '',
			auth_kind TEXT NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none','bearer','oauth')),
			status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','connected','needs_auth','error')),
			last_error TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_connected_at TEXT
		);
		CREATE INDEX IF NOT EXISTS gateways_user ON gateways(user_id);
		CREATE TABLE IF NOT EXISTS gateway_pending (
			state TEXT PRIMARY KEY,
			gateway_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			code_verifier TEXT,
			expires_at INTEGER NOT NULL
		);
	`);
  return db;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newUserId(): string {
  return `u_${randomBytes(6).toString("hex")}`;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function pruneExpired(db: Database.Database): void {
  const t = now();
  db.prepare("DELETE FROM pending_auth WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM gateway_pending WHERE expires_at < ?").run(t);
  // Expired/revoked tokens are kept 30 days for refresh-reuse detection, then dropped.
  db.prepare("DELETE FROM tokens WHERE expires_at < ? - 2592000").run(t);
}

// ---------------------------------------------------------------------------
// users

export function getUser(db: Database.Database, id: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

/**
 * Find-or-create on a verified IdP login. Matches by stable `sub` first (so an
 * email change at the IdP updates the row), then adopts a pre-created row by
 * email (import path: operator-created rows have no sub until first login).
 */
export function upsertUserOnLogin(
  db: Database.Database,
  { sub, email }: { sub: string; email: string },
): User {
  const bySub = db.prepare("SELECT * FROM users WHERE oidc_sub = ?").get(sub) as User | undefined;
  if (bySub) {
    db.prepare("UPDATE users SET email = ?, last_login_at = datetime('now') WHERE id = ?").run(
      email,
      bySub.id,
    );
    return getUser(db, bySub.id) as User;
  }
  const byEmail = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | undefined;
  if (byEmail) {
    db.prepare("UPDATE users SET oidc_sub = ?, last_login_at = datetime('now') WHERE id = ?").run(
      sub,
      byEmail.id,
    );
    return getUser(db, byEmail.id) as User;
  }
  const id = newUserId();
  db.prepare(
    "INSERT INTO users (id, email, oidc_sub, last_login_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(id, email, sub);
  return getUser(db, id) as User;
}

export function findUserByEmail(db: Database.Database, email: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | undefined;
}

/** Remove the user row plus everything keyed to it (tokens, sessions). */
export function deleteUser(db: Database.Database, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM auth_codes WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  })();
}

// ---------------------------------------------------------------------------
// dynamic client registration

export function registerClient(db: Database.Database, redirectUris: string[]): string {
  const clientId = randomToken(16);
  db.prepare("INSERT INTO clients (client_id, redirect_uris) VALUES (?, ?)").run(
    clientId,
    JSON.stringify(redirectUris),
  );
  return clientId;
}

export function getClientRedirectUris(
  db: Database.Database,
  clientId: string,
): string[] | undefined {
  const row = db.prepare("SELECT redirect_uris FROM clients WHERE client_id = ?").get(clientId) as
    | { redirect_uris: string }
    | undefined;
  return row ? (JSON.parse(row.redirect_uris) as string[]) : undefined;
}

// ---------------------------------------------------------------------------
// pending authorization (state across the IdP roundtrip)

export function createPendingAuth(db: Database.Database, payload: object, ttlSec = 600): string {
  pruneExpired(db);
  const state = randomToken();
  db.prepare("INSERT INTO pending_auth (state, payload, expires_at) VALUES (?, ?, ?)").run(
    state,
    JSON.stringify(payload),
    now() + ttlSec,
  );
  return state;
}

export function consumePendingAuth<T>(db: Database.Database, state: string): T | undefined {
  const row = db
    .prepare("SELECT payload, expires_at FROM pending_auth WHERE state = ?")
    .get(state) as { payload: string; expires_at: number } | undefined;
  db.prepare("DELETE FROM pending_auth WHERE state = ?").run(state);
  if (!row || row.expires_at < now()) return undefined;
  return JSON.parse(row.payload) as T;
}

// ---------------------------------------------------------------------------
// authorization codes

export type AuthCodeGrant = {
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
};

export function createAuthCode(db: Database.Database, grant: AuthCodeGrant, ttlSec = 300): string {
  const code = randomToken();
  db.prepare(
    `INSERT INTO auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256Hex(code),
    grant.user_id,
    grant.client_id,
    grant.redirect_uri,
    grant.code_challenge,
    now() + ttlSec,
  );
  return code;
}

/** Single use: the row is deleted whether or not it is still valid. */
export function consumeAuthCode(db: Database.Database, code: string): AuthCodeGrant | undefined {
  const hash = sha256Hex(code);
  const row = db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(hash) as
    | (AuthCodeGrant & { expires_at: number })
    | undefined;
  db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(hash);
  if (!row || row.expires_at < now()) return undefined;
  return row;
}

// ---------------------------------------------------------------------------
// opaque access/refresh tokens

export function issueTokens(
  db: Database.Database,
  userId: string,
  clientId: string,
  accessTtlSec: number,
  refreshTtlSec: number,
): IssuedTokens {
  pruneExpired(db);
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const insert = db.prepare(
    "INSERT INTO tokens (user_id, client_id, kind, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    insert.run(userId, clientId, "access", sha256Hex(accessToken), now() + accessTtlSec);
    insert.run(userId, clientId, "refresh", sha256Hex(refreshToken), now() + refreshTtlSec);
  })();
  return { accessToken, refreshToken, expiresIn: accessTtlSec };
}

export function lookupAccessToken(
  db: Database.Database,
  token: string,
): { userId: string } | undefined {
  const row = db
    .prepare(
      "SELECT user_id FROM tokens WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at >= ?",
    )
    .get(sha256Hex(token), now()) as { user_id: string } | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE token_hash = ?").run(
    sha256Hex(token),
  );
  return { userId: row.user_id };
}

/**
 * Refresh-token rotation with reuse detection: a valid token is revoked and a
 * fresh pair issued; presenting an already-rotated token is treated as theft
 * and revokes every token for that user+client.
 */
export function rotateRefreshToken(
  db: Database.Database,
  token: string,
  accessTtlSec: number,
  refreshTtlSec: number,
): IssuedTokens | "reused" | undefined {
  const hash = sha256Hex(token);
  const row = db
    .prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'")
    .get(hash) as
    | { user_id: string; client_id: string; expires_at: number; revoked_at: number | null }
    | undefined;
  if (!row || row.expires_at < now()) return undefined;
  if (row.revoked_at !== null) {
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ?").run(
      now(),
      row.user_id,
      row.client_id,
    );
    return "reused";
  }
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?").run(now(), hash);
  return issueTokens(db, row.user_id, row.client_id, accessTtlSec, refreshTtlSec);
}

// ---------------------------------------------------------------------------
// account-page web sessions

export function createWebSession(
  db: Database.Database,
  userId: string,
  ttlSec = 86400,
): { id: string; csrf: string } {
  pruneExpired(db);
  const id = randomToken();
  const csrf = randomToken(16);
  db.prepare("INSERT INTO web_sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)").run(
    id,
    userId,
    csrf,
    now() + ttlSec,
  );
  return { id, csrf };
}

export function getWebSession(
  db: Database.Database,
  id: string,
): { userId: string; csrf: string } | undefined {
  const row = db
    .prepare("SELECT user_id, csrf FROM web_sessions WHERE id = ? AND expires_at >= ?")
    .get(id, now()) as { user_id: string; csrf: string } | undefined;
  return row ? { userId: row.user_id, csrf: row.csrf } : undefined;
}

export function deleteWebSession(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM web_sessions WHERE id = ?").run(id);
}
