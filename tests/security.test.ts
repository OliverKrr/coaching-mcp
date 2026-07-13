// coaching-mcp/tests/security.test.ts — secret-store crypto and rate limiter units.
import type { IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAuthDatabase } from "../src/auth/db.js";
import {
  deleteAllUserSecrets,
  deleteUserSecret,
  getUserSecret,
  getUserSecretMeta,
  openSecret,
  parseSecretsKey,
  sealSecret,
  setUserSecret,
} from "../src/auth/secrets.js";
import { RateLimiter } from "../src/ratelimit.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

describe("secret sealing (AES-256-GCM)", () => {
  it("round-trips and produces versioned ciphertext", () => {
    const sealed = sealSecret(KEY, "u_1", "hevy_api_key", "s3cret");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("s3cret");
    expect(openSecret(KEY, "u_1", "hevy_api_key", sealed)).toBe("s3cret");
  });

  it("fails closed on wrong key, tampering, and cross-slot replay", () => {
    const sealed = sealSecret(KEY, "u_1", "hevy_api_key", "s3cret");
    expect(openSecret(OTHER_KEY, "u_1", "hevy_api_key", sealed)).toBeUndefined();
    // flip the first IV character (index 3, after "v1:") — a base64url group's
    // leading char carries fully significant bits, so A↔B is always a real change
    // (the old flip of the second-to-last char was a no-op whenever that char was
    // already the replacement letter, making this test flaky under random IVs)
    const tampered = sealed.slice(0, 3) + (sealed[3] === "A" ? "B" : "A") + sealed.slice(4);
    expect(openSecret(KEY, "u_1", "hevy_api_key", tampered)).toBeUndefined();
    // AAD binds user and slot: the same blob is useless for another user/name
    expect(openSecret(KEY, "u_2", "hevy_api_key", sealed)).toBeUndefined();
    expect(openSecret(KEY, "u_1", "other_secret", sealed)).toBeUndefined();
  });

  it("parseSecretsKey enforces 32 bytes", () => {
    expect(parseSecretsKey(undefined)).toBeUndefined();
    expect(parseSecretsKey(Buffer.alloc(32, 1).toString("base64"))?.length).toBe(32);
    expect(() => parseSecretsKey("dG9vc2hvcnQ=")).toThrow(/32 bytes/);
  });

  it("stores, reports meta only, and deletes per user", () => {
    const db = openAuthDatabase(mkdtempSync(join(tmpdir(), "secrets-")));
    setUserSecret(db, KEY, "u_1", "hevy_api_key", "alpha");
    setUserSecret(db, KEY, "u_2", "hevy_api_key", "beta");

    expect(getUserSecret(db, KEY, "u_1", "hevy_api_key")).toBe("alpha");
    expect(getUserSecret(db, KEY, "u_2", "hevy_api_key")).toBe("beta");
    expect(getUserSecretMeta(db, "u_1", "hevy_api_key")?.updated_at).toBeTruthy();

    setUserSecret(db, KEY, "u_1", "hevy_api_key", "alpha2"); // upsert
    expect(getUserSecret(db, KEY, "u_1", "hevy_api_key")).toBe("alpha2");

    deleteUserSecret(db, "u_1", "hevy_api_key");
    expect(getUserSecret(db, KEY, "u_1", "hevy_api_key")).toBeUndefined();
    expect(getUserSecret(db, KEY, "u_2", "hevy_api_key")).toBe("beta");

    deleteAllUserSecrets(db, "u_2");
    expect(getUserSecret(db, KEY, "u_2", "hevy_api_key")).toBeUndefined();
    db.close();
  });
});

describe("RateLimiter", () => {
  const req = (ip: string): IncomingMessage =>
    ({ headers: { "cf-connecting-ip": ip }, socket: {} }) as unknown as IncomingMessage;

  it("caps per IP within the window and resets after it", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.allow(req("1.1.1.1"), 0)).toBe(true);
    expect(limiter.allow(req("1.1.1.1"), 10)).toBe(true);
    expect(limiter.allow(req("1.1.1.1"), 20)).toBe(false);
    expect(limiter.allow(req("2.2.2.2"), 20)).toBe(true); // other IPs unaffected
    expect(limiter.allow(req("1.1.1.1"), 1500)).toBe(true); // new window
  });
});
