// coaching-mcp/tests/serve.test.ts — multi-user serve mode end to end:
// OAuth flow against a mock OIDC issuer, allowlist gating, per-user tenancy
// over real MCP sessions, refresh rotation, and the account page (export,
// delete). No network beyond 127.0.0.1.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { unzipSync, strFromU8 } from "fflate";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServeConfig } from "../src/context.js";
import { buildHttpServer, createContext } from "../src/serve.js";

// ---------------------------------------------------------------------------
// Mock OIDC issuer

type MockIdentity = { sub: string; email: string; emailVerified?: boolean };

class MockIssuer {
  nextIdentity: MockIdentity = { sub: "sub-default", email: "default@example.com" };
  url = "";
  private server!: Server;
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly codes = new Map<string, { nonce: string; identity: MockIdentity }>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: this.url,
            authorization_endpoint: `${this.url}/authorize`,
            token_endpoint: `${this.url}/token`,
            jwks_uri: `${this.url}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
        return;
      }
      if (url.pathname === "/jwks") {
        const jwk = this.keys.publicKey.export({ format: "jwk" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }));
        return;
      }
      if (url.pathname === "/authorize") {
        const code = randomBytes(16).toString("hex");
        this.codes.set(code, {
          nonce: url.searchParams.get("nonce") ?? "",
          identity: this.nextIdentity,
        });
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", code);
        const state = url.searchParams.get("state");
        if (state) redirect.searchParams.set("state", state);
        res.writeHead(302, { location: redirect.href });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          const params = new URLSearchParams(body);
          const grant = this.codes.get(params.get("code") ?? "");
          if (!grant) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          const now = Math.floor(Date.now() / 1000);
          const idToken = this.signJwt({
            iss: this.url,
            aud: "test-client",
            sub: grant.identity.sub,
            email: grant.identity.email,
            email_verified: grant.identity.emailVerified ?? true,
            nonce: grant.nonce,
            iat: now,
            exp: now + 300,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: randomBytes(8).toString("hex"),
              token_type: "bearer",
              expires_in: 300,
              id_token: idToken,
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address === null || typeof address === "string") throw new Error("no address");
        this.url = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  private signJwt(payload: object): string {
    const enc = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const signingInput = `${enc({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${enc(payload)}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.keys.privateKey)
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// App under test

const issuer = new MockIssuer();
let appServer: Server;
let base = "";
let dataDir = "";
let closeApp: () => void;
const savedAllowlist = process.env.ALLOWED_EMAILS;

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

beforeAll(async () => {
  await issuer.start();

  dataDir = mkdtempSync(join(tmpdir(), "serve-data-"));
  const seedDir = mkdtempSync(join(tmpdir(), "serve-seed-"));
  writeFileSync(join(seedDir, "SKILL.md"), "# Template Skill\n\nOnboarding placeholder.");
  mkdirSync(join(seedDir, "references"));
  writeFileSync(join(seedDir, "references", "zones.md"), "# Zones template");

  process.env.ALLOWED_EMAILS = `${ALICE}, ${BOB}`;

  const cfg: ServeConfig = {
    dataDir,
    seedDir,
    port: 0,
    publicUrl: "http://placeholder.invalid",
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 7776000,
  };
  const { ctx, mcpSessions } = createContext(cfg, {
    OIDC_ISSUER: issuer.url,
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-secret",
  });
  ctx.log = () => {}; // keep test output quiet
  appServer = buildHttpServer(ctx, mcpSessions);
  await new Promise<void>((resolve) => {
    appServer.listen(0, "127.0.0.1", () => {
      const address = appServer.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      base = `http://127.0.0.1:${address.port}`;
      cfg.publicUrl = base; // handlers read cfg per request
      resolve();
    });
  });
  closeApp = () => {
    void mcpSessions.closeAll();
    ctx.tenants.closeAll();
    ctx.authDb.close();
  };
});

afterAll(async () => {
  closeApp();
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await issuer.stop();
  if (savedAllowlist === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = savedAllowlist;
});

// ---------------------------------------------------------------------------
// helpers

const REDIRECT_URI = "http://localhost:9/cb";

async function registerClient(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Drive the full authorize → IdP → callback redirect chain for `identity`. */
async function runAuthorizeFlow(identity: MockIdentity, authorizeUrl: string): Promise<Response> {
  issuer.nextIdentity = identity;
  const r1 = await fetch(authorizeUrl, { redirect: "manual" });
  expect(r1.status).toBe(302);
  const idpLocation = r1.headers.get("location") ?? "";
  expect(idpLocation.startsWith(issuer.url)).toBe(true);
  const r2 = await fetch(idpLocation, { redirect: "manual" });
  expect(r2.status).toBe(302);
  // our /oidc/callback — outcome depends on the allowlist
  return fetch(r2.headers.get("location") ?? "", { redirect: "manual" });
}

async function oauthLogin(email: string): Promise<{
  access: string;
  refresh: string;
  clientId: string;
}> {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authorizeUrl =
    `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=client-xyz`;

  const r3 = await runAuthorizeFlow({ sub: `sub-${email}`, email }, authorizeUrl);
  expect(r3.status).toBe(302);
  const clientRedirect = new URL(r3.headers.get("location") ?? "");
  expect(clientRedirect.href.startsWith(REDIRECT_URI)).toBe(true);
  expect(clientRedirect.searchParams.get("state")).toBe("client-xyz");
  const code = clientRedirect.searchParams.get("code") ?? "";
  expect(code).not.toBe("");

  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { access: tokens.access_token, refresh: tokens.refresh_token, clientId };
}

async function mcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function accountLogin(email: string): Promise<string> {
  const r3 = await runAuthorizeFlow({ sub: `sub-${email}`, email }, `${base}/account/login`);
  expect(r3.status).toBe(302);
  expect(r3.headers.get("location")).toBe(`${base}/account`);
  const setCookie = r3.headers.get("set-cookie") ?? "";
  const match = /account_session=([^;]+)/.exec(setCookie);
  expect(match).not.toBeNull();
  return `account_session=${match?.[1] ?? ""}`;
}

// ---------------------------------------------------------------------------

describe("discovery metadata", () => {
  it("serves AS metadata at the plain and RFC 8414 suffixed paths", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/coaching",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const meta = (await res.json()) as Record<string, unknown>;
      expect(meta.issuer).toBe(base);
      expect(meta.token_endpoint).toBe(`${base}/token`);
      expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    }
  });

  it("serves protected-resource metadata", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.authorization_servers).toEqual([base]);
  });
});

describe("OAuth flow with OIDC federation", () => {
  it("rejects /mcp without a token, pointing at resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("denies a non-allowlisted email and provisions nothing", async () => {
    const clientId = await registerClient();
    const authorizeUrl =
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=x&code_challenge_method=S256`;
    const usersBefore = existsSync(join(dataDir, "users"))
      ? readdirSync(join(dataDir, "users")).length
      : 0;
    const r3 = await runAuthorizeFlow(
      { sub: "sub-mallory", email: "mallory@example.com" },
      authorizeUrl,
    );
    expect(r3.status).toBe(403);
    const usersAfter = existsSync(join(dataDir, "users"))
      ? readdirSync(join(dataDir, "users")).length
      : 0;
    expect(usersAfter).toBe(usersBefore);
  });

  it("rejects an unregistered redirect_uri outright", async () => {
    const clientId = await registerClient();
    const res = await fetch(
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent("http://evil.example/cb")}&code_challenge=x&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a wrong PKCE verifier and enforces single-use codes", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const authorizeUrl =
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`;
    const r3 = await runAuthorizeFlow({ sub: `sub-${ALICE}`, email: ALICE }, authorizeUrl);
    const code = new URL(r3.headers.get("location") ?? "").searchParams.get("code") ?? "";

    const bad = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      }),
    });
    expect(bad.status).toBe(400);

    // the code was consumed by the failed attempt — replay is dead too
    const replay = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    });
    expect(replay.status).toBe(400);
  });

  it("rotates refresh tokens and revokes the chain on reuse", async () => {
    const { refresh } = await oauthLogin(ALICE);

    const refreshOnce = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    });
    expect(refreshOnce.status).toBe(200);
    const rotated = (await refreshOnce.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(refresh);

    // reusing the rotated-away token is treated as theft…
    const reuse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    });
    expect(reuse.status).toBe(400);

    // …which revokes the whole chain, including the fresh pair
    const afterReuse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
      }),
    });
    expect(afterReuse.status).toBe(400);
  });
});

describe("multi-tenant MCP sessions", () => {
  it("seeds each user from the template and isolates their data", async () => {
    const alice = await oauthLogin(ALICE);
    const bob = await oauthLogin(BOB);

    const clientA = await mcpClient(alice.access);
    const clientB = await mcpClient(bob.access);

    const contextA = toolText(
      await clientA.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(contextA).toContain("Template Skill");

    await clientA.callTool({
      name: "update_section",
      arguments: { name: "main", content: "# Alice's private plan" },
    });

    const contextA2 = toolText(
      await clientA.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(contextA2).toContain("Alice's private plan");

    const contextB = toolText(
      await clientB.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(contextB).toContain("Template Skill");
    expect(contextB).not.toContain("Alice");

    await clientA.close();
    await clientB.close();

    // two user dirs on disk, each with its own skill.db
    const users = readdirSync(join(dataDir, "users"));
    expect(users.length).toBeGreaterThanOrEqual(2);
    for (const u of users) {
      expect(existsSync(join(dataDir, "users", u, "skill.db"))).toBe(true);
    }
  });
});

describe("account page", () => {
  it("shows the profile after IdP login", async () => {
    const cookie = await accountLogin(ALICE);
    const res = await fetch(`${base}/account`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(ALICE);
    expect(html).toContain("Journal entries");
  });

  it("exports a zip containing markdown docs and the database", async () => {
    const cookie = await accountLogin(ALICE);
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csrf).not.toBe("");

    const res = await fetch(`${base}/account/export`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zip)).toEqual(
      expect.arrayContaining([
        "SKILL.md",
        "journal.md",
        "open-items.md",
        "seed-manifest.json",
        "skill.db",
      ]),
    );
    expect(strFromU8(zip["SKILL.md"] as Uint8Array)).toContain("Alice's private plan");
  });

  it("refuses export/delete with a bad CSRF token", async () => {
    const cookie = await accountLogin(ALICE);
    const res = await fetch(`${base}/account/export`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  it("deletes the account: data gone, tokens revoked", async () => {
    const bob = await oauthLogin(BOB);
    const cookie = await accountLogin(BOB);
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

    // wrong confirmation → nothing happens
    const wrong = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, confirm_email: "not-bob@example.com" }),
    });
    expect(wrong.status).toBe(400);

    const usersBefore = readdirSync(join(dataDir, "users")).length;
    const res = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, confirm_email: BOB }),
    });
    expect(res.status).toBe(200);
    expect(readdirSync(join(dataDir, "users")).length).toBe(usersBefore - 1);

    // access token no longer works
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bob.access}` },
      body: "{}",
    });
    expect(mcp.status).toBe(401);

    // signing in again starts a fresh, empty account (seeded from template)
    const again = await oauthLogin(BOB);
    const client = await mcpClient(again.access);
    const context = toolText(
      await client.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(context).toContain("Template Skill");
    await client.close();
  });
});
