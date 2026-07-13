// coaching-mcp/tests/serve.test.ts — multi-user serve mode end to end:
// OAuth flow against a mock OIDC issuer, allowlist gating, per-user tenancy
// over real MCP sessions, refresh rotation, and the account page (export,
// delete). No network beyond 127.0.0.1.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { assertSafeGatewayUrl, sdkInternals } from "../src/gateways.js";
import { unzipSync, strFromU8 } from "fflate";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServeConfig } from "../src/context.js";
import { authRateLimiter } from "../src/ratelimit.js";
import { buildHttpServer, createContext } from "../src/serve.js";
import { listen, MockIssuer, type MockIdentity } from "./helpers/mock-oidc.js";

// ---------------------------------------------------------------------------
// Mock Hevy API + mock protected app (both on 127.0.0.1)

const hevyValidKeys = new Set<string>(["valid-hevy-key"]);
let hevyTemplatePages = 0; // counts catalog page fetches — asserts the search cache works
let lastHevyBody: unknown; // last JSON body a write endpoint received
const mockHevy = createServer((req, res) => {
  if (!hevyValidKeys.has((req.headers["api-key"] as string) ?? "")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const url = new URL(req.url ?? "/", "http://hevy");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" || req.method === "PUT") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastHevyBody = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      json(201, { ok: true, received: lastHevyBody });
    });
    return;
  }
  if (url.pathname === "/workouts/count") {
    json(200, { workout_count: 42 });
    return;
  }
  if (url.pathname === "/workouts") {
    json(200, { page: 1, workouts: [{ id: "w1", title: "Bench day" }] });
    return;
  }
  if (url.pathname === "/exercise_templates") {
    // Two catalog pages so allExerciseTemplates() has to paginate.
    hevyTemplatePages++;
    const page = Number(url.searchParams.get("page") ?? "1");
    json(200, {
      page,
      page_count: 2,
      exercise_templates:
        page === 1
          ? [
              { id: "t1", title: "Bench Press (Barbell)", primary_muscle_group: "chest" },
              { id: "t2", title: "Squat (Barbell)", primary_muscle_group: "quadriceps" },
            ]
          : [{ id: "t3", title: "Incline Bench Press (Dumbbell)", primary_muscle_group: "chest" }],
    });
    return;
  }
  if (url.pathname === "/user/info") {
    json(200, { data: { id: "u1", name: "Alice", url: "https://hevy.example/alice" } });
    return;
  }
  res.writeHead(404);
  res.end();
});

const mockApp = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://app");
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "dash_sid=abc; Path=/; HttpOnly",
    });
    res.end('<html><a href="/page">go</a><form action="/login" hx-post="/api/x"></form></html>');
    return;
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/target" });
    res.end();
    return;
  }
  if (url.pathname === "/echo" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-seen-prefix": (req.headers["x-forwarded-prefix"] as string) ?? "",
      });
      res.end(Buffer.concat(chunks));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---------------------------------------------------------------------------
// App under test

const issuer = new MockIssuer();
let appServer: Server;
let base = "";
let dataDir = "";
let closeApp: () => void;
const savedAllowlist = process.env.ALLOWED_EMAILS;
const savedHevyBase = process.env.HEVY_API_BASE;
const savedRegistration = process.env.REGISTRATION;

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

beforeAll(async () => {
  await issuer.start();
  process.env.HEVY_API_BASE = await listen(mockHevy);
  const mockAppUrl = await listen(mockApp);
  authRateLimiter.configure(1_000_000); // the real limit is exercised in its own test

  dataDir = mkdtempSync(join(tmpdir(), "serve-data-"));
  const seedDir = mkdtempSync(join(tmpdir(), "serve-seed-"));
  writeFileSync(join(seedDir, "SKILL.md"), "# Template Skill\n\nOnboarding placeholder.");
  mkdirSync(join(seedDir, "references"));
  writeFileSync(join(seedDir, "references", "zones.md"), "# Zones template");
  // a minimal topic pack so /routines has templates to render
  mkdirSync(join(seedDir, "topics", "training", "routines"), { recursive: true });
  writeFileSync(
    join(seedDir, "topics", "training", "topic.md"),
    "# Training\n\nEndurance coaching pack for tests.\n",
  );
  writeFileSync(
    join(seedDir, "topics", "training", "routines", "weekly-review.md"),
    "# Weekly Review\n\nCadence: weekly, Sunday evening\n\nLoad get_coaching_context, then write the check-in of record.\n",
  );

  process.env.ALLOWED_EMAILS = `${ALICE}, ${BOB}`;
  // This suite covers the classic invite-only mode; self-registration has its
  // own suite (tests/registration.test.ts).
  process.env.REGISTRATION = "closed";

  const cfg: ServeConfig = {
    dataDir,
    seedDir,
    port: 0,
    publicUrl: "http://placeholder.invalid",
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 7776000,
    secretsKey: Buffer.alloc(32, 7),
    apps: [{ name: "testapp", url: mockAppUrl, emails: new Set([ALICE]) }],
    quotaDefaultMb: 50,
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
  await new Promise<void>((resolve) => mockHevy.close(() => resolve()));
  await new Promise<void>((resolve) => mockApp.close(() => resolve()));
  if (savedAllowlist === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = savedAllowlist;
  if (savedHevyBase === undefined) delete process.env.HEVY_API_BASE;
  else process.env.HEVY_API_BASE = savedHevyBase;
  if (savedRegistration === undefined) delete process.env.REGISTRATION;
  else process.env.REGISTRATION = savedRegistration;
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

  it("serves MCP at the root path too — the connector URL form", async () => {
    // unauthenticated initialize at the bare server URL must get the OAuth
    // bootstrap challenge (this is what an MCP connector client sends first)
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");

    // a plain browser GET still sees the landing page, not an MCP error
    const browser = await fetch(`${base}/`);
    expect(browser.status).toBe(200);
    expect(browser.headers.get("content-type")).toContain("text/html");

    // and a real authenticated MCP session works against the root URL
    const alice = await oauthLogin(ALICE);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/`), {
      requestInit: { headers: { authorization: `Bearer ${alice.access}` } },
    });
    const client = new Client({ name: "root-probe", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("get_coaching_context");
    // Serve-mode-only tools (registered in mcp-http.ts, not covered by the
    // annotations suite) must carry grouping metadata on the wire too.
    expect(tools.tools.map((t) => t.name)).toContain("request_quota_increase");
    for (const t of tools.tools) {
      expect(t.title, `${t.name}: missing title`).toBeTruthy();
      expect(t.annotations, `${t.name}: missing annotations`).toBeDefined();
    }
    await client.close();
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

describe("landing page setup guide", () => {
  it("serves the guide in English and German (query param + Accept-Language)", async () => {
    const en = await (await fetch(`${base}/`)).text();
    expect(en).toContain("Set up in five steps");
    expect(en).toContain(base); // the connector URL is shown for copy-paste
    expect(en).toContain("get_coaching_context"); // project-instructions block

    const de = await (await fetch(`${base}/?lang=de`)).text();
    expect(de).toContain("Einrichtung in fünf Schritten");

    const auto = await (
      await fetch(`${base}/`, { headers: { "accept-language": "de-DE,de;q=0.9" } })
    ).text();
    expect(auto).toContain("Einrichtung in fünf Schritten");
  });

  it("explains the routine flow and renders pack templates at /routines", async () => {
    const en = await (await fetch(`${base}/routines`)).text();
    expect(en).toContain("Design it with your coach");
    expect(en).toContain("Weekly Review"); // template from the topic pack fixture
    expect(en).toContain("weekly, Sunday evening"); // parsed cadence shown
    expect(en).toContain("get_coaching_context"); // prompt text present

    const de = await (await fetch(`${base}/routines?lang=de`)).text();
    expect(de).toContain("Mit dem Coach entwerfen");
    expect(de).toContain("Weekly Review"); // templates stay English masters

    // the landing guide links to it
    const landing = await (await fetch(`${base}/`)).text();
    expect(landing).toContain("/routines");
  });

  it("persists an explicit ?lang= choice via cookie, all the way into the account area", async () => {
    const res = await fetch(`${base}/?lang=de`, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("lang=de");

    const cookie = await accountLogin(ALICE);
    const account = await (
      await fetch(`${base}/account`, { headers: { cookie: `${cookie}; lang=de` } })
    ).text();
    expect(account).toContain("Gefahrenzone"); // danger zone, translated
    expect(account).toContain("Angemeldet als");
    // and the German choice does not leak into cookie-less requests
    const en = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(en).toContain("Danger zone");
  });

  it("builds the nav around the signed-in user", async () => {
    const anon = await (await fetch(`${base}/`)).text();
    expect(anon).toContain("Sign in</a>");
    expect(anon).not.toContain(">Data</a>");

    const cookie = await accountLogin(ALICE);
    const signedIn = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(signedIn).toContain(">Data</a>");
    expect(signedIn).toContain(">Account</a>");
  });

  it("shows the signed-in user's own routines on /routines", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf = /name="csrf" value="([^"]+)"/.exec(
      await (await fetch(`${base}/account`, { headers: { cookie } })).text(),
    )?.[1] as string;
    await fetch(`${base}/account/data/routines/save`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        name: "own-checkin",
        cadence: "weekly, Friday",
        prompt: "Review the week and flag anything odd.",
        status: "active",
        expected_updated_at: "",
      }),
      redirect: "manual",
    });
    const signedIn = await (await fetch(`${base}/routines`, { headers: { cookie } })).text();
    expect(signedIn).toContain("Your routines");
    expect(signedIn).toContain("own-checkin");
    expect(signedIn).toContain("Review the week and flag anything odd.");
    expect(signedIn).toContain("prompt updated"); // master-vs-pasted-copy drift hint
    expect(signedIn).toContain('class="copybox"'); // Ctrl+A stays inside the prompt box
    expect(signedIn).toContain("Weekly Review"); // templates still listed below

    const anon = await (await fetch(`${base}/routines`)).text();
    expect(anon).not.toContain("Your routines");
  });
});

describe("account data editor", () => {
  async function csrfFor(cookie: string): Promise<string> {
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csrf).not.toBe("");
    return csrf;
  }

  const FORM = "application/x-www-form-urlencoded";

  it("requires a session for data pages", async () => {
    const res = await fetch(`${base}/account/data`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${base}/account`);
  });

  it("lists documents, creates a new section, and refuses duplicate names", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);

    const overview = await (await fetch(`${base}/account/data`, { headers: { cookie } })).text();
    expect(overview).toContain("main");
    expect(overview).toContain("zones");

    const create = (): Promise<Response> =>
      fetch(`${base}/account/data/doc/save`, {
        method: "POST",
        headers: { cookie, "content-type": FORM },
        body: new URLSearchParams({
          csrf,
          type: "section",
          name: "race-plan",
          content: "# Race plan\n\n10k in autumn.",
          expected_updated_at: "",
        }),
        redirect: "manual",
      });
    expect((await create()).status).toBe(302);
    const docPage = await (
      await fetch(`${base}/account/data/doc?type=section&name=race-plan`, { headers: { cookie } })
    ).text();
    expect(docPage).toContain("10k in autumn");

    expect((await create()).status).toBe(409); // duplicate name refused
  });

  it("shows a rendered markdown preview beside the editor", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);
    await fetch(`${base}/account/data/doc/save`, {
      method: "POST",
      headers: { cookie, "content-type": FORM },
      body: new URLSearchParams({
        csrf,
        type: "section",
        name: "preview-check",
        content: "## Plan\n\n**boldy** move\n\n<script>alert(1)</script>",
        expected_updated_at: "",
      }),
      redirect: "manual",
    });
    const html = await (
      await fetch(`${base}/account/data/doc?type=section&name=preview-check`, {
        headers: { cookie },
      })
    ).text();
    expect(html).toContain('<div class="preview">');
    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain("<strong>boldy</strong>");
    // raw HTML in the document stays escaped in BOTH the textarea and the preview
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("creates, edits, and deletes routines with concurrency + status guards", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);

    const save = (body: Record<string, string>): Promise<Response> =>
      fetch(`${base}/account/data/routines/save`, {
        method: "POST",
        headers: { cookie, "content-type": FORM },
        body: new URLSearchParams({ csrf, ...body }),
        redirect: "manual",
      });

    // create
    const created = await save({
      name: "meal-plan",
      cadence: "weekly, Saturday morning",
      status: "active",
      prompt: "Plan next week's meals. Grocery list before shopping day.",
      expected_updated_at: "",
    });
    expect(created.status).toBe(302);

    // it shows up on the overview + list + editor
    const overview = await (await fetch(`${base}/account/data`, { headers: { cookie } })).text();
    expect(overview).toContain("Routines");
    const list = await (
      await fetch(`${base}/account/data/routines`, { headers: { cookie } })
    ).text();
    expect(list).toContain("meal-plan");
    const editor = await (
      await fetch(`${base}/account/data/routines/edit?name=meal-plan`, { headers: { cookie } })
    ).text();
    expect(editor).toContain("Grocery list before shopping day");
    const token = /name="expected_updated_at" value="([^"]+)"/.exec(editor)?.[1] ?? "";
    expect(token).not.toBe("");

    // duplicate create refused; invalid status refused
    expect(
      (
        await save({
          name: "meal-plan",
          cadence: "daily",
          status: "active",
          prompt: "x",
          expected_updated_at: "",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await save({
          name: "meal-plan",
          cadence: "daily",
          status: "bogus",
          prompt: "x",
          expected_updated_at: token,
        })
      ).status,
    ).toBe(400);

    // update with the current token works; a stale token conflicts
    expect(
      (
        await save({
          name: "meal-plan",
          cadence: "weekly, Friday evening",
          status: "paused",
          prompt: "Plan v2.",
          expected_updated_at: token,
        })
      ).status,
    ).toBe(302);
    expect(
      (
        await save({
          name: "meal-plan",
          cadence: "daily",
          status: "active",
          prompt: "clobber attempt",
          expected_updated_at: "2000-01-01 00:00:00",
        })
      ).status,
    ).toBe(409);
    const after = await (
      await fetch(`${base}/account/data/routines/edit?name=meal-plan`, { headers: { cookie } })
    ).text();
    expect(after).toContain("Plan v2.");
    expect(after).not.toContain("clobber attempt");

    // delete
    const del = await fetch(`${base}/account/data/routines/delete`, {
      method: "POST",
      headers: { cookie, "content-type": FORM },
      body: new URLSearchParams({ csrf, name: "meal-plan" }),
      redirect: "manual",
    });
    expect(del.status).toBe(302);
    const afterDelete = await fetch(`${base}/account/data/routines/edit?name=meal-plan`, {
      headers: { cookie },
    });
    expect(afterDelete.status).toBe(404);
  });

  it("saves with the current token and rejects a stale one (optimistic concurrency)", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);
    const docPage = await (
      await fetch(`${base}/account/data/doc?type=reference&name=zones`, { headers: { cookie } })
    ).text();
    const token = /name="expected_updated_at" value="([^"]+)"/.exec(docPage)?.[1] ?? "";
    expect(token).not.toBe("");

    const save = (expected: string, content: string): Promise<Response> =>
      fetch(`${base}/account/data/doc/save`, {
        method: "POST",
        headers: { cookie, "content-type": FORM },
        body: new URLSearchParams({
          csrf,
          type: "reference",
          name: "zones",
          content,
          expected_updated_at: expected,
        }),
        redirect: "manual",
      });

    expect((await save(token, "# Zones v2")).status).toBe(302);
    // an obviously stale token → conflict, nothing written
    const conflict = await save("2000-01-01 00:00:00", "# clobber attempt");
    expect(conflict.status).toBe(409);
    const after = await (
      await fetch(`${base}/account/data/doc?type=reference&name=zones`, { headers: { cookie } })
    ).text();
    expect(after).toContain("Zones v2");
    expect(after).not.toContain("clobber attempt");
  });

  it("protects main from deletion but deletes other documents", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);
    const del = (type: string, name: string): Promise<Response> =>
      fetch(`${base}/account/data/doc/delete`, {
        method: "POST",
        headers: { cookie, "content-type": FORM },
        body: new URLSearchParams({ csrf, type, name }),
        redirect: "manual",
      });
    expect((await del("section", "main")).status).toBe(400);
    expect((await del("section", "race-plan")).status).toBe(302);
    const gone = await fetch(`${base}/account/data/doc?type=section&name=race-plan`, {
      headers: { cookie },
    });
    expect(gone.status).toBe(404);
  });

  it("edits journal entries and keeps FTS search in sync (journal_au trigger)", async () => {
    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    await client.callTool({
      name: "append_journal",
      arguments: { entry: "Session about **threshold** blorbing" },
    });

    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);
    const journalPage = await (
      await fetch(`${base}/account/data/journal`, { headers: { cookie } })
    ).text();
    expect(journalPage).toContain("blorbing");
    expect(journalPage).toContain("<strong>threshold</strong>"); // entries render as markdown
    const id = /journal\/edit\?id=(\d+)/.exec(journalPage)?.[1] ?? "";
    expect(id).not.toBe("");

    const save = await fetch(`${base}/account/data/journal/save`, {
      method: "POST",
      headers: { cookie, "content-type": FORM },
      body: new URLSearchParams({ csrf, id, entry: "Session about threshold glimmerwork" }),
      redirect: "manual",
    });
    expect(save.status).toBe(302);

    // FTS reflects the edit: new wording found, old wording gone
    const hit = toolText(
      await client.callTool({
        name: "search_knowledge",
        arguments: { query: "glimmerwork", type: "journal" },
      }),
    );
    expect(hit).toContain("glimmerwork");
    const miss = toolText(
      await client.callTool({
        name: "search_knowledge",
        arguments: { query: "blorbing", type: "journal" },
      }),
    );
    expect(miss).not.toContain("Session about");

    // delete removes the entry from the page
    const del = await fetch(`${base}/account/data/journal/delete`, {
      method: "POST",
      headers: { cookie, "content-type": FORM },
      body: new URLSearchParams({ csrf, id }),
      redirect: "manual",
    });
    expect(del.status).toBe(302);
    const afterDelete = await (
      await fetch(`${base}/account/data/journal`, { headers: { cookie } })
    ).text();
    expect(afterDelete).not.toContain("glimmerwork");
    await client.close();
  });

  it("edits open items in a way the MCP tools observe", async () => {
    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    await client.callTool({
      name: "add_open_item",
      arguments: { kind: "commitment", content: "If it rains, then **treadmill**" },
    });

    const cookie = await accountLogin(ALICE);
    const csrf = await csrfFor(cookie);
    const listPage = await (
      await fetch(`${base}/account/data/open-items`, { headers: { cookie } })
    ).text();
    expect(listPage).toContain("<strong>treadmill</strong>"); // items render as markdown
    const id = /open-items\/edit\?id=(\d+)/.exec(listPage)?.[1] ?? "";
    expect(id).not.toBe("");

    const save = await fetch(`${base}/account/data/open-items/save`, {
      method: "POST",
      headers: { cookie, "content-type": FORM },
      body: new URLSearchParams({
        csrf,
        id,
        content: "If it rains, then bike trainer",
        status: "done",
        relevant_date: "",
      }),
      redirect: "manual",
    });
    expect(save.status).toBe(302);

    // default list_open_items (status=open) no longer shows it
    const open = toolText(await client.callTool({ name: "list_open_items", arguments: {} }));
    expect(open).not.toContain("bike trainer");
    const done = toolText(
      await client.callTool({ name: "list_open_items", arguments: { status: "done" } }),
    );
    expect(done).toContain("bike trainer");
    await client.close();
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
    expect(html).toContain('<header class="site">'); // shared nav chrome
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
        "routines.md",
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

describe("hardening", () => {
  it("sends strict security headers on every rendered page", async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // and the pages actually contain no scripts, so the CSP costs nothing
    expect(await res.text()).not.toContain("<script");
  });

  it("rate-limits the auth endpoints per client IP", async () => {
    authRateLimiter.configure(3);
    try {
      const hit = (): Promise<Response> =>
        fetch(`${base}/register`, {
          method: "POST",
          headers: { "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" },
          body: "{}",
        });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await hit()).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
      // other clients are unaffected
      const other = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.7", "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
      });
      expect(other.status).toBe(201);
    } finally {
      authRateLimiter.configure(1_000_000);
    }
  });
});

describe("user secrets & Hevy integration", () => {
  it("connects Hevy after live validation, rejects bad keys", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf =
      /name="csrf" value="([^"]+)"/.exec(
        await (await fetch(`${base}/account`, { headers: { cookie } })).text(),
      )?.[1] ?? "";

    const save = (key: string): Promise<Response> =>
      fetch(`${base}/account/integrations/hevy`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, api_key: key }),
        redirect: "manual",
      });

    expect((await save("wrong-key")).status).toBe(400); // rejected by the Hevy API, not stored
    let account = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(account).toContain("not connected");

    expect((await save("valid-hevy-key")).status).toBe(302);
    account = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(account).toContain("connected");
    expect(account).not.toContain("valid-hevy-key"); // the key is never rendered back
  });

  it("registers Hevy tools only for users with a key", async () => {
    const alice = await oauthLogin(ALICE);
    const clientA = await mcpClient(alice.access);
    const toolsA = (await clientA.listTools()).tools.map((t) => t.name);
    expect(toolsA).toContain("hevy_get_workout_count");
    expect(toolsA).toContain("hevy_create_routine");

    const count = toolText(
      await clientA.callTool({ name: "hevy_get_workout_count", arguments: {} }),
    );
    expect(count).toContain("42");
    await clientA.close();

    // Full parity surface: every resource family is present.
    for (const name of [
      "hevy_get_workout_events",
      "hevy_create_workout",
      "hevy_update_workout",
      "hevy_get_routine",
      "hevy_search_exercise_templates",
      "hevy_get_exercise_template",
      "hevy_get_exercise_history",
      "hevy_create_exercise_template",
      "hevy_get_routine_folder",
      "hevy_get_body_measurements",
      "hevy_create_body_measurement",
      "hevy_update_body_measurement",
      "hevy_get_user_info",
    ]) {
      expect(toolsA).toContain(name);
    }

    const bob = await oauthLogin(BOB);
    const clientB = await mcpClient(bob.access);
    const toolsB = (await clientB.listTools()).tools.map((t) => t.name);
    expect(toolsB).not.toContain("hevy_get_workout_count");
    await clientB.close();
  });

  it("searches the template catalog across pages and caches it per session", async () => {
    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    try {
      hevyTemplatePages = 0;
      const hits = toolText(
        await client.callTool({
          name: "hevy_search_exercise_templates",
          arguments: { query: "bench press", muscleGroup: "chest" },
        }),
      );
      expect(hits).toContain("t1");
      expect(hits).toContain("t3"); // page 2 result — pagination happened
      expect(hits).not.toContain('"t2"'); // squat filtered out
      expect(hevyTemplatePages).toBe(2);

      // Second search reuses the session cache — no new catalog fetches.
      await client.callTool({
        name: "hevy_search_exercise_templates",
        arguments: { query: "squat" },
      });
      expect(hevyTemplatePages).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("sends the documented wire shapes on writes", async () => {
    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    try {
      await client.callTool({
        name: "hevy_create_workout",
        arguments: {
          title: "Push day",
          startTime: "2026-07-06T10:00:00Z",
          endTime: "2026-07-06T11:00:00Z",
          exercises: [
            { exerciseTemplateId: "t1", sets: [{ type: "normal", weightKg: 80, reps: 5 }] },
          ],
        },
      });
      const workout = (lastHevyBody as { workout: Record<string, unknown> }).workout;
      expect(workout.start_time).toBe("2026-07-06T10:00:00Z");
      expect(workout.is_private).toBe(false);
      const wSet = (workout.exercises as Array<{ sets: Array<Record<string, unknown>> }>)[0]
        .sets[0];
      expect(wSet).toMatchObject({ weight_kg: 80, reps: 5, rpe: null });
      expect(wSet).not.toHaveProperty("rep_range"); // workout sets: rpe, no rep_range

      await client.callTool({
        name: "hevy_create_routine",
        arguments: {
          title: "5x5",
          exercises: [{ exerciseTemplateId: "t2", sets: [{ repRange: { start: 5, end: 5 } }] }],
        },
      });
      const routine = (lastHevyBody as { routine: Record<string, unknown> }).routine;
      const rSet = (routine.exercises as Array<{ sets: Array<Record<string, unknown>> }>)[0]
        .sets[0];
      expect(rSet.rep_range).toEqual({ start: 5, end: 5 }); // routine sets: rep_range, no rpe
      expect(rSet).not.toHaveProperty("rpe");

      await client.callTool({
        name: "hevy_create_body_measurement",
        arguments: { date: "2026-07-06", weightKg: 81.5 },
      });
      // Flat body: no wrapper, only provided fields (the API rejects nulls here).
      expect(lastHevyBody).toEqual({ date: "2026-07-06", weight_kg: 81.5 });
    } finally {
      await client.close();
    }
  });

  it("answers with guidance instead of an error when Hevy revokes the key", async () => {
    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    hevyValidKeys.delete("valid-hevy-key");
    try {
      const out = toolText(
        await client.callTool({ name: "hevy_get_workout_count", arguments: {} }),
      );
      expect(out).toContain("account page");
    } finally {
      hevyValidKeys.add("valid-hevy-key");
      await client.close();
    }
  });

  it("disconnects Hevy: tools disappear for new sessions", async () => {
    const cookie = await accountLogin(ALICE);
    const csrf =
      /name="csrf" value="([^"]+)"/.exec(
        await (await fetch(`${base}/account`, { headers: { cookie } })).text(),
      )?.[1] ?? "";
    const res = await fetch(`${base}/account/integrations/hevy/delete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("hevy_get_workout_count");
    await client.close();
  });
});

describe("protected app proxy", () => {
  it("requires a session", async () => {
    const res = await fetch(`${base}/apps/testapp/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${base}/account`);
  });

  it("requires the app's own allowlist, not just a login", async () => {
    const cookie = await accountLogin(BOB);
    const res = await fetch(`${base}/apps/testapp/`, { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("proxies for allowlisted users, rewriting HTML/Location/cookies onto the prefix", async () => {
    const cookie = await accountLogin(ALICE);

    const home = await fetch(`${base}/apps/testapp/`, { headers: { cookie } });
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('href="/apps/testapp/page"');
    expect(html).toContain('action="/apps/testapp/login"');
    expect(html).toContain('hx-post="/apps/testapp/api/x"');
    expect(home.headers.get("set-cookie")).toContain("Path=/apps/testapp/");

    const redirect = await fetch(`${base}/apps/testapp/redirect`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/apps/testapp/target");

    const echo = await fetch(`${base}/apps/testapp/echo`, {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: "ping-through",
    });
    expect(await echo.text()).toBe("ping-through");
    expect(echo.headers.get("x-seen-prefix")).toBe("/apps/testapp");

    // the account page lists the tool for authorized users
    const account = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(account).toContain("/apps/testapp/");
  });

  it("404s for unknown apps", async () => {
    const cookie = await accountLogin(ALICE);
    const res = await fetch(`${base}/apps/nope/`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// MCP gateways — user-attached upstream MCP servers, mounted verbatim

type MockUpstream = {
  url: string;
  issuedTokens: Set<string>;
  close: () => Promise<void>;
};

/**
 * A minimal upstream MCP server over Streamable HTTP: two tools (one of which
 * deliberately collides with a native coaching tool name), optional static
 * bearer auth, optional full OAuth AS (metadata + DCR + authorize + token with
 * PKCE verification).
 */
async function startMockUpstream(opts: {
  bearer?: string;
  oauth?: boolean;
  queryToken?: string;
  instructions?: string;
}): Promise<MockUpstream> {
  const issuedTokens = new Set<string>();
  const authCodes = new Map<string, { challenge: string }>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let baseUrl = "http://pending";

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", baseUrl);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };

      if (opts.oauth) {
        if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
          json(200, {
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;
        }
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          json(200, { resource: baseUrl, authorization_servers: [baseUrl] });
          return;
        }
        if (url.pathname === "/register" && req.method === "POST") {
          let body = "";
          for await (const chunk of req) body += chunk;
          json(201, {
            ...(JSON.parse(body) as Record<string, unknown>),
            client_id: "upstream-client",
          });
          return;
        }
        if (url.pathname === "/authorize" && req.method === "GET") {
          const code = randomBytes(8).toString("hex");
          authCodes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "" });
          const target = new URL(url.searchParams.get("redirect_uri") ?? "");
          target.searchParams.set("code", code);
          const state = url.searchParams.get("state");
          if (state) target.searchParams.set("state", state);
          res.writeHead(302, { location: target.href });
          res.end();
          return;
        }
        if (url.pathname === "/token" && req.method === "POST") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const params = new URLSearchParams(body);
          const grant = authCodes.get(params.get("code") ?? "");
          const expected = createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url");
          if (!grant || grant.challenge !== expected) {
            json(400, { error: "invalid_grant" });
            return;
          }
          const token = `up-${randomBytes(8).toString("hex")}`;
          issuedTokens.add(token);
          json(200, {
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "up-refresh",
          });
          return;
        }
      }

      // Everything else is the MCP endpoint — auth gate first.
      if (opts.queryToken !== undefined && url.searchParams.get("token") !== opts.queryToken) {
        json(401, { error: "bad or missing token query parameter" });
        return;
      }
      const authHeader = req.headers.authorization;
      if (opts.bearer !== undefined && authHeader !== `Bearer ${opts.bearer}`) {
        json(401, { error: "unauthorized" });
        return;
      }
      if (opts.oauth) {
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
        if (!token || !issuedTokens.has(token)) {
          json(
            401,
            { error: "unauthorized" },
            {
              "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
            },
          );
          return;
        }
      }

      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        const transport = transports.get(sessionId);
        if (!transport) {
          json(404, { error: "unknown session" });
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      const upstream = new McpServer(
        { name: "mock-upstream", version: "1.0.0" },
        opts.instructions ? { instructions: opts.instructions } : undefined,
      );
      upstream.registerTool(
        "get_activities",
        {
          title: "Get Activities",
          description: "UPSTREAM-DESC: list recent activities",
          inputSchema: { days: z.number().int().describe("How many days back") },
        },
        ({ days }) => ({ content: [{ type: "text", text: `activities:${days}` }] }),
      );
      // Deliberate collision with the native coaching tool of the same name.
      upstream.registerTool(
        "get_version",
        { description: "upstream version", inputSchema: {} },
        () => ({ content: [{ type: "text", text: "upstream-version" }] }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(8).toString("hex"),
        onsessioninitialized: (sid) => transports.set(sid, transport),
      });
      await upstream.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  const url = await listen(httpServer);
  baseUrl = url;
  return {
    url,
    issuedTokens,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

describe("MCP gateways (user-attached upstream servers)", () => {
  let upOpen: MockUpstream;
  let upBearer: MockUpstream;
  let upOauth: MockUpstream;

  beforeAll(async () => {
    process.env.GATEWAY_ALLOW_INSECURE = "1"; // mock upstreams are http://127.0.0.1
    upOpen = await startMockUpstream({
      instructions: "UPSTREAM-INSTRUCTIONS: check wellness before prescribing.",
    });
    upBearer = await startMockUpstream({ bearer: "up-secret" });
    upOauth = await startMockUpstream({ oauth: true });
  });

  afterAll(async () => {
    delete process.env.GATEWAY_ALLOW_INSECURE;
    await upOpen.close();
    await upBearer.close();
    await upOauth.close();
  });

  async function loginWithCsrf(email: string): Promise<{ cookie: string; csrf: string }> {
    const cookie = await accountLogin(email);
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return { cookie, csrf };
  }

  async function addGateway(
    session: { cookie: string; csrf: string },
    fields: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${base}/account/gateways`, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: session.csrf, ...fields }),
      redirect: "manual",
    });
  }

  async function accountHtml(session: { cookie: string }): Promise<string> {
    return (await fetch(`${base}/account`, { headers: { cookie: session.cookie } })).text();
  }

  async function removeAllGateways(session: { cookie: string; csrf: string }): Promise<void> {
    const html = await accountHtml(session);
    const ids = new Set(
      [...html.matchAll(/gateways\/(gw_[A-Za-z0-9_-]+)\/delete/g)].map((m) => m[1] as string),
    );
    for (const id of ids) {
      await fetch(`${base}/account/gateways/${id}/delete`, {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: session.csrf }),
        redirect: "manual",
      });
    }
  }

  it("holds the pinned-SDK internals contract the passthrough depends on", () => {
    const probe = new McpServer({ name: "probe", version: "0.0.0" });
    probe.registerTool("noop", { description: "noop", inputSchema: {} }, () => ({
      content: [],
    }));
    const { handlers, nativeNames } = sdkInternals(probe);
    expect(handlers.has("tools/list")).toBe(true);
    expect(handlers.has("tools/call")).toBe(true);
    expect(nativeNames.has("noop")).toBe(true);
  });

  it("rejects unsafe URLs outside test mode", async () => {
    delete process.env.GATEWAY_ALLOW_INSECURE;
    try {
      await expect(assertSafeGatewayUrl("http://example.com/mcp")).rejects.toThrow(/https/);
      await expect(assertSafeGatewayUrl("https://127.0.0.1/mcp")).rejects.toThrow(/private/);
      await expect(assertSafeGatewayUrl("https://[::1]/mcp")).rejects.toThrow(/private/);
      await expect(assertSafeGatewayUrl("https://169.254.169.254/meta")).rejects.toThrow(/private/);
      await expect(assertSafeGatewayUrl("https://10.0.0.8/mcp")).rejects.toThrow(/private/);
      await expect(assertSafeGatewayUrl("not a url")).rejects.toThrow(/invalid/);
    } finally {
      process.env.GATEWAY_ALLOW_INSECURE = "1";
    }
  });

  it("mounts an upstream: derived prefix, attributed title/description, verbatim schema", async () => {
    const session = await loginWithCsrf(ALICE);
    try {
      const added = await addGateway(session, { name: "Fitness", url: upOpen.url });
      expect(added.status).toBe(302);
      expect(added.headers.get("location")).toBe(`${base}/account`);
      const account = await accountHtml(session);
      expect(account).toContain("Fitness");
      expect(account).toContain("fitness_*"); // derived prefix shown on the card
      expect(account).toContain("connected");

      const alice = await oauthLogin(ALICE);
      const client = await mcpClient(alice.access);
      try {
        const tools = (await client.listTools()).tools;
        expect(tools.map((t) => t.name)).toContain("get_coaching_context"); // natives intact
        const mountedTool = tools.find((t) => t.name === "fitness_get_activities");
        // Attribution: server name leads description AND title (permission UIs show titles).
        expect(mountedTool?.description).toBe("Fitness: UPSTREAM-DESC: list recent activities");
        expect(mountedTool?.title).toBe("Fitness: Get Activities");
        const schema = mountedTool?.inputSchema as {
          properties?: Record<string, { description?: string }>;
        };
        expect(schema.properties?.days?.description).toBe("How many days back"); // verbatim
        expect(client.getInstructions()).toContain("UPSTREAM-INSTRUCTIONS");
        expect(client.getInstructions()).toContain('"fitness_" prefix');

        const out = toolText(
          await client.callTool({ name: "fitness_get_activities", arguments: { days: 7 } }),
        );
        expect(out).toContain("activities:7");

        // The upstream's get_version mounts prefixed; the native one stays native.
        const native = toolText(await client.callTool({ name: "get_version", arguments: {} }));
        expect(native).not.toContain("upstream-version");
        const mounted = toolText(
          await client.callTool({ name: "fitness_get_version", arguments: {} }),
        );
        expect(mounted).toContain("upstream-version");
      } finally {
        await client.close();
      }
    } finally {
      await removeAllGateways(session);
    }
  });

  it("an explicit prefix overrides the derived one; duplicate prefixes are rejected", async () => {
    const session = await loginWithCsrf(ALICE);
    try {
      await addGateway(session, { name: "Prefixed", url: upOpen.url, prefix: "fit" });
      const dup = await addGateway(session, { name: "Other", url: upOpen.url, prefix: "fit" });
      expect(dup.status).toBe(400); // prefix uniqueness enforced

      const alice = await oauthLogin(ALICE);
      const client = await mcpClient(alice.access);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("fit_get_activities");
        expect(names).toContain("fit_get_version");
        const version = toolText(await client.callTool({ name: "fit_get_version", arguments: {} }));
        expect(version).toContain("upstream-version");
      } finally {
        await client.close();
      }
    } finally {
      await removeAllGateways(session);
    }
  });

  it("query-token URL: token split off, sealed, never rendered, re-attached on connect", async () => {
    const upQuery = await startMockUpstream({ queryToken: "sekret-token-123" });
    const session = await loginWithCsrf(ALICE);
    try {
      const added = await addGateway(session, {
        name: "IcuLike",
        url: `${upQuery.url}/mcp?token=sekret-token-123`,
      });
      expect(added.status).toBe(302);
      const account = await accountHtml(session);
      expect(account).toContain("connected");
      expect(account).toContain(`${upQuery.url}/mcp`); // clean base URL shown
      expect(account).toContain("embedded access token stored encrypted");
      expect(account).not.toContain("sekret-token-123"); // the credential never renders

      const alice = await oauthLogin(ALICE);
      const client = await mcpClient(alice.access);
      try {
        const out = toolText(
          await client.callTool({ name: "iculike_get_activities", arguments: { days: 5 } }),
        );
        expect(out).toContain("activities:5"); // query re-attached at connect time
      } finally {
        await client.close();
      }
    } finally {
      await removeAllGateways(session);
      await upQuery.close();
    }
  });

  it("bearer upstream: wrong token surfaces as an error, right token mounts", async () => {
    const session = await loginWithCsrf(ALICE);
    try {
      await addGateway(session, { name: "WrongTok", url: upBearer.url, bearer: "nope" });
      expect(await accountHtml(session)).toContain("error");
      await removeAllGateways(session);

      await addGateway(session, { name: "TokenServer", url: upBearer.url, bearer: "up-secret" });
      expect(await accountHtml(session)).toContain("connected");
      const alice = await oauthLogin(ALICE);
      const client = await mcpClient(alice.access);
      try {
        const out = toolText(
          await client.callTool({ name: "tokenserver_get_activities", arguments: { days: 3 } }),
        );
        expect(out).toContain("activities:3");
      } finally {
        await client.close();
      }
    } finally {
      await removeAllGateways(session);
    }
  });

  it("oauth upstream: full authorize dance from the account page, tokens sealed and used", async () => {
    const session = await loginWithCsrf(BOB);
    try {
      const added = await addGateway(session, { name: "OAuthUp", url: upOauth.url });
      expect(added.status).toBe(302);
      const authorizeUrl = added.headers.get("location") ?? "";
      expect(authorizeUrl.startsWith(`${upOauth.url}/authorize`)).toBe(true);

      const upstreamRedirect = await fetch(authorizeUrl, { redirect: "manual" });
      expect(upstreamRedirect.status).toBe(302);
      const callbackUrl = upstreamRedirect.headers.get("location") ?? "";
      expect(callbackUrl.startsWith(`${base}/account/gateways/callback`)).toBe(true);

      const callback = await fetch(callbackUrl, {
        headers: { cookie: session.cookie },
        redirect: "manual",
      });
      expect(callback.status).toBe(302); // success → back to the account page
      expect(await accountHtml(session)).toContain("connected");
      expect(upOauth.issuedTokens.size).toBeGreaterThan(0);

      const bob = await oauthLogin(BOB);
      const client = await mcpClient(bob.access);
      try {
        const out = toolText(
          await client.callTool({ name: "oauthup_get_activities", arguments: { days: 1 } }),
        );
        expect(out).toContain("activities:1");
      } finally {
        await client.close();
      }
    } finally {
      await removeAllGateways(session);
    }
  });

  it("removed gateways disappear from new sessions", async () => {
    const session = await loginWithCsrf(ALICE);
    await addGateway(session, { name: "Temp", url: upOpen.url });
    await removeAllGateways(session);
    const alice = await oauthLogin(ALICE);
    const client = await mcpClient(alice.access);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("temp_get_activities");
    } finally {
      await client.close();
    }
  });

  it("suggests known servers and ?preset= prefills the add form", async () => {
    const session = await loginWithCsrf(BOB);
    await removeAllGateways(session);
    const plain = await accountHtml(session);
    expect(plain).toContain("https://icusync.icu/");
    expect(plain).not.toContain('value="IcuSync"'); // suggestion listed, form untouched
    const prefilled = await (
      await fetch(`${base}/account?preset=icusync`, { headers: { cookie: session.cookie } })
    ).text();
    expect(prefilled).toContain('value="IcuSync"');
    expect(prefilled).toContain('value="icusync"');
    expect(prefilled).toContain("IcuSync dashboard");
  });

  it("hides a suggestion once its prefix is attached and ignores unknown presets", async () => {
    const session = await loginWithCsrf(BOB);
    await removeAllGateways(session);
    await addGateway(session, { name: "IcuSync", url: upOpen.url }); // prefix derives to icusync
    const html = await accountHtml(session);
    expect(html).not.toContain("https://icusync.icu/");
    await removeAllGateways(session);
    const unknown = await (
      await fetch(`${base}/account?preset=doesnotexist`, { headers: { cookie: session.cookie } })
    ).text();
    expect(unknown).toContain("https://icusync.icu/"); // suggestion back after removal
    expect(unknown).not.toContain('value="IcuSync"'); // unknown preset: no prefill
  });
});
