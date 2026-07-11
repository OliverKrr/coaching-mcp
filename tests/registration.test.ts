// coaching-mcp/tests/registration.test.ts — self-registration end to end:
// unknown login → pending request + notifications (webhook + Telegram), the
// Telegram opt-in deep link and approve/reject callbacks, /admin actions,
// disable revocation, and storage quotas incl. request_quota_increase.
// serve.test.ts covers the classic invite-only mode; this suite runs with an
// empty allowlist, ADMIN_EMAILS only, and registration open. No network
// beyond 127.0.0.1.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail, getUser } from "../src/auth/db.js";
import type { ServeConfig, ServeContext } from "../src/context.js";
import { authRateLimiter } from "../src/ratelimit.js";
import { buildHttpServer, createContext } from "../src/serve.js";
import type { TelegramBot } from "../src/telegram.js";
import { listen, MockIssuer, type MockIdentity } from "./helpers/mock-oidc.js";

// ---------------------------------------------------------------------------
// Mock Telegram Bot API + plain notify webhook (both on 127.0.0.1)

type TgCall = { method: string; payload: Record<string, unknown> };
const tgCalls: TgCall[] = [];
const mockTelegram = createServer((req, res) => {
  const m = /^\/bottest-token\/(\w+)$/.exec(req.url ?? "");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    const method = m[1] as string;
    tgCalls.push({
      method,
      payload: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>,
    });
    const result =
      method === "getMe"
        ? { username: "coachbot" }
        : method === "sendMessage"
          ? { message_id: tgCalls.length }
          : true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
const tgSends = (): TgCall[] => tgCalls.filter((c) => c.method === "sendMessage");

const notifyBodies: string[] = [];
const mockNotify = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    notifyBodies.push(Buffer.concat(chunks).toString());
    res.writeHead(200);
    res.end("ok");
  });
});

/** Notifications are fire-and-forget — poll briefly instead of racing them. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// App under test

const issuer = new MockIssuer();
let ctx: ServeContext;
let bot: TelegramBot;
let base = "";
let dataDir = "";
let closeApp: () => void;
let appServer: ReturnType<typeof buildHttpServer>;
const savedEnv: Record<string, string | undefined> = {};

const ADMIN = "admin@example.com";
const ADMIN_CHAT = "424242";
const CAROL = "carol@example.com";
const DAVE = "dave@example.com";
const ERIN = "erin@example.com";
const CAROL_CHAT = 777;

beforeAll(async () => {
  await issuer.start();
  const telegramUrl = await listen(mockTelegram);
  const notifyUrl = await listen(mockNotify);
  authRateLimiter.configure(1_000_000);

  for (const key of ["ADMIN_EMAILS", "ALLOWED_EMAILS", "ALLOWED_EMAILS_FILE", "REGISTRATION"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ADMIN_EMAILS = ADMIN;

  dataDir = mkdtempSync(join(tmpdir(), "reg-data-"));
  const seedDir = mkdtempSync(join(tmpdir(), "reg-seed-"));
  writeFileSync(join(seedDir, "SKILL.md"), "# Template Skill\n\nOnboarding placeholder.");

  const cfg: ServeConfig = {
    dataDir,
    seedDir,
    port: 0,
    publicUrl: "http://placeholder.invalid",
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 7776000,
    apps: [],
    quotaDefaultMb: 0.01, // ≈10.5 KB — small enough to exercise quota paths
  };
  const created = createContext(cfg, {
    OIDC_ISSUER: issuer.url,
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
    TELEGRAM_API_BASE: telegramUrl,
    NOTIFY_URL: notifyUrl,
  });
  ctx = created.ctx;
  ctx.log = () => {};
  const maybeBot = ctx.notify.telegram;
  if (!maybeBot) throw new Error("telegram bot not configured");
  bot = maybeBot;

  appServer = buildHttpServer(ctx, created.mcpSessions);
  await new Promise<void>((resolve) => {
    appServer.listen(0, "127.0.0.1", () => {
      const address = appServer.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      base = `http://127.0.0.1:${address.port}`;
      cfg.publicUrl = base;
      resolve();
    });
  });
  await bot.setup(base); // getMe (username for deep links) + setWebhook
  closeApp = () => {
    void created.mcpSessions.closeAll();
    ctx.tenants.closeAll();
    ctx.authDb.close();
  };
});

afterAll(async () => {
  closeApp();
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await issuer.stop();
  await new Promise<void>((resolve) => mockTelegram.close(() => resolve()));
  await new Promise<void>((resolve) => mockNotify.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// helpers (mirrors serve.test.ts, slimmed to what this suite needs)

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

async function runAuthorizeFlow(identity: MockIdentity, authorizeUrl: string): Promise<Response> {
  issuer.nextIdentity = identity;
  const r1 = await fetch(authorizeUrl, { redirect: "manual" });
  expect(r1.status).toBe(302);
  const r2 = await fetch(r1.headers.get("location") ?? "", { redirect: "manual" });
  expect(r2.status).toBe(302);
  return fetch(r2.headers.get("location") ?? "", { redirect: "manual" });
}

async function oauthLogin(email: string): Promise<{ access: string }> {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const r3 = await runAuthorizeFlow(
    { sub: `sub-${email}`, email },
    `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(r3.status).toBe(302);
  const code = new URL(r3.headers.get("location") ?? "").searchParams.get("code") ?? "";
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
  return { access: ((await tokenRes.json()) as { access_token: string }).access_token };
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
  const match = /account_session=([^;]+)/.exec(r3.headers.get("set-cookie") ?? "");
  return `account_session=${match?.[1] ?? ""}`;
}

async function csrfFor(cookie: string): Promise<string> {
  const res = await fetch(`${base}/account`, { headers: { cookie } });
  const match = /name="csrf" value="([^"]+)"/.exec(await res.text());
  return match?.[1] ?? "";
}

async function adminPost(
  cookie: string,
  csrf: string,
  path: string,
  extra = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ...extra }),
  });
}

async function postWebhook(update: object, secret?: string): Promise<Response> {
  return fetch(`${base}/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify(update),
  });
}

function userCount(): number {
  return existsSync(join(dataDir, "users")) ? readdirSync(join(dataDir, "users")).length : 0;
}

// ---------------------------------------------------------------------------

let carolPendingHtml = "";
let carolId = "";

describe("self-registration", () => {
  it("turns an unknown verified email into a pending request — notified once, nothing provisioned", async () => {
    const tenantsBefore = userCount();
    const sendsBefore = tgSends().length;
    const r = await runAuthorizeFlow(
      { sub: `sub-${CAROL}`, email: CAROL, name: "Carol Example" },
      `${base}/account/login`,
    );
    expect(r.status).toBe(200);
    carolPendingHtml = await r.text();
    expect(carolPendingHtml).toContain("Request received");
    expect(carolPendingHtml).toContain("https://t.me/coachbot?start=");

    const carol = findUserByEmail(ctx.authDb, CAROL);
    expect(carol?.status).toBe("pending");
    expect(carol?.name).toBe("Carol Example");
    carolId = carol?.id ?? "";
    expect(userCount()).toBe(tenantsBefore); // no coaching DB provisioned

    await waitFor(() => tgSends().length === sendsBefore + 1, "signup telegram message");
    await waitFor(() => notifyBodies.length === 1, "signup webhook");
    expect(notifyBodies[0]).toContain(CAROL);
    const signup = tgSends()[sendsBefore]?.payload as {
      chat_id: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(signup.chat_id).toBe(ADMIN_CHAT);
    expect(signup.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe(`approve:${carolId}`);

    // repeat login: still pending, and deliberately NOT re-notified
    const again = await runAuthorizeFlow(
      { sub: `sub-${CAROL}`, email: CAROL },
      `${base}/account/login`,
    );
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Still awaiting approval");
    expect(notifyBodies.length).toBe(1);
    expect(tgSends().length).toBe(sendsBefore + 1);
  });

  it("lets the admin in with no allowlist configured", async () => {
    const { access } = await oauthLogin(ADMIN);
    const client = await mcpClient(access);
    const context = toolText(
      await client.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(context).toContain("Template Skill");
    await client.close();
  });

  it("links the user's Telegram chat via the /start deep link, refusing bad secrets", async () => {
    const token = /start=([A-Za-z0-9_-]+)/.exec(carolPendingHtml)?.[1] ?? "";
    expect(token).not.toBe("");

    const noSecret = await postWebhook({
      message: {
        message_id: 1,
        chat: { id: CAROL_CHAT, type: "private" },
        text: `/start ${token}`,
      },
    });
    expect(noSecret.status).toBe(403);

    const ok = await postWebhook(
      {
        message: {
          message_id: 1,
          chat: { id: CAROL_CHAT, type: "private" },
          text: `/start ${token}`,
        },
      },
      bot.webhookSecret,
    );
    expect(ok.status).toBe(200);
    expect(getUser(ctx.authDb, carolId)?.telegram_chat_id).toBe(String(CAROL_CHAT));
    const reply = tgSends().at(-1)?.payload as { chat_id: unknown; text: string };
    expect(String(reply.chat_id)).toBe(String(CAROL_CHAT));
    expect(reply.text).toContain("Connected");
  });

  it("ignores membership callbacks from a chat that is not the admin's", async () => {
    const res = await postWebhook(
      {
        callback_query: { id: "cq-evil", from: { id: 999 }, data: `approve:${carolId}` },
      },
      bot.webhookSecret,
    );
    expect(res.status).toBe(200);
    expect(getUser(ctx.authDb, carolId)?.status).toBe("pending");
  });

  it("activates the user on the admin's Approve button and messages them", async () => {
    const res = await postWebhook(
      {
        callback_query: {
          id: "cq-1",
          from: { id: Number(ADMIN_CHAT) },
          message: {
            message_id: 5,
            chat: { id: Number(ADMIN_CHAT) },
            text: "New coaching access request",
          },
          data: `approve:${carolId}`,
        },
      },
      bot.webhookSecret,
    );
    expect(res.status).toBe(200);
    expect(getUser(ctx.authDb, carolId)?.status).toBe("active");
    const edited = tgCalls.filter((c) => c.method === "editMessageText").at(-1)?.payload as {
      text: string;
    };
    expect(edited.text).toContain("Approved");
    await waitFor(
      () =>
        tgSends().some(
          (c) =>
            String(c.payload.chat_id) === String(CAROL_CHAT) &&
            String(c.payload.text).includes("approved"),
        ),
      "user approval message",
    );

    // and now the full OAuth + MCP path works, provisioning her coaching DB
    const { access } = await oauthLogin(CAROL);
    const client = await mcpClient(access);
    const context = toolText(
      await client.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(context).toContain("Template Skill");
    await client.close();
  });

  it("rejected users get one neutral page, not a request loop", async () => {
    const r = await runAuthorizeFlow({ sub: `sub-${DAVE}`, email: DAVE }, `${base}/account/login`);
    expect(r.status).toBe(200); // pending created
    const daveId = findUserByEmail(ctx.authDb, DAVE)?.id ?? "";

    const cookie = await accountLogin(ADMIN);
    const csrf = await csrfFor(cookie);
    const rejected = await adminPost(cookie, csrf, `/admin/users/${daveId}/reject`);
    expect(rejected.status).toBe(302);

    const denied = await runAuthorizeFlow(
      { sub: `sub-${DAVE}`, email: DAVE },
      `${base}/account/login`,
    );
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("Access not granted");
  });

  it("serves /admin only to admins; disable revokes live tokens", async () => {
    await runAuthorizeFlow({ sub: `sub-${ERIN}`, email: ERIN }, `${base}/account/login`);
    const erinId = findUserByEmail(ctx.authDb, ERIN)?.id ?? "";
    const adminCookie = await accountLogin(ADMIN);
    const adminCsrf = await csrfFor(adminCookie);
    await adminPost(adminCookie, adminCsrf, `/admin/users/${erinId}/approve`);

    const { access } = await oauthLogin(ERIN);
    const client = await mcpClient(access);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();

    // active but non-admin: /admin does not exist for her
    const erinCookie = await accountLogin(ERIN);
    const forErin = await fetch(`${base}/admin`, { headers: { cookie: erinCookie } });
    expect(forErin.status).toBe(404);

    // admin sees her on the page — wrapped in Cloudflare's email-obfuscation
    // opt-out comments, or a proxied deployment would hide every address
    const forAdmin = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } });
    expect(forAdmin.status).toBe(200);
    expect(await forAdmin.text()).toContain(`<!--email_off-->${ERIN}<!--/email_off-->`);

    // disable → the bearer token she already holds dies immediately
    await adminPost(adminCookie, adminCsrf, `/admin/users/${erinId}/disable`);
    const afterDisable = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(afterDisable.status).toBe(401);
    const denied = await runAuthorizeFlow(
      { sub: `sub-${ERIN}`, email: ERIN },
      `${base}/account/login`,
    );
    expect(denied.status).toBe(403);
  });

  it("caps /mcp request bodies", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(2 * 1024 * 1024 + 64)}"}`,
    });
    expect(res.status).toBe(413);
  });
});

describe("storage quotas over MCP", () => {
  it("enforces the quota with warnings from 80% and a self-describing error", async () => {
    const { access } = await oauthLogin(CAROL);
    const client = await mcpClient(access); // quota: 0.01 MB ≈ 10486 bytes

    const first = toolText(
      await client.callTool({
        name: "update_section",
        arguments: { name: "notes", content: "n".repeat(7000) },
      }),
    );
    expect(first).toContain("updated");
    expect(first).not.toContain("Storage:"); // ~67% — below the warning line

    const second = toolText(
      await client.callTool({
        name: "update_section",
        arguments: { name: "plans", content: "p".repeat(2000) },
      }),
    );
    expect(second).toContain("Storage:"); // ~86% — warning attached

    const third = toolText(
      await client.callTool({
        name: "update_section",
        arguments: { name: "extra", content: "e".repeat(3000) },
      }),
    );
    expect(third).toContain("Storage quota exceeded");
    expect(third).toContain("request_quota_increase");

    const version = JSON.parse(
      toolText(await client.callTool({ name: "get_version", arguments: {} })),
    ) as Record<string, number>;
    expect(version.storage_quota_bytes).toBe(Math.round(0.01 * 1024 * 1024));
    expect(version.storage_bytes).toBeGreaterThan(9000);

    // session start carries the warning too
    const context = toolText(
      await client.callTool({ name: "get_coaching_context", arguments: {} }),
    );
    expect(context).toContain("Storage:");
    await client.close();
  });

  it("request_quota_increase notifies the operator once; a Telegram grant raises the quota", async () => {
    const { access } = await oauthLogin(CAROL);
    const client = await mcpClient(access);
    const sendsBefore = tgSends().length;

    const sent = toolText(
      await client.callTool({
        name: "request_quota_increase",
        arguments: { reason: "Collecting long training plans and race references" },
      }),
    );
    expect(sent).toContain("Request sent");
    await waitFor(() => tgSends().length === sendsBefore + 1, "quota request telegram message");
    const request = tgSends().at(-1)?.payload as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    const grantButton = request.reply_markup.inline_keyboard[0]?.[0]?.callback_data ?? "";
    expect(grantButton).toMatch(new RegExp(`^quota:${carolId}:\\d+$`));

    const duplicate = toolText(
      await client.callTool({
        name: "request_quota_increase",
        arguments: { reason: "Asking again immediately for more space" },
      }),
    );
    expect(duplicate).toContain("already waiting");
    await client.close();

    // grant via the button (0.01 MB × 1.5, ceiled → 1 MB)
    const res = await postWebhook(
      {
        callback_query: {
          id: "cq-2",
          from: { id: Number(ADMIN_CHAT) },
          message: {
            message_id: 9,
            chat: { id: Number(ADMIN_CHAT) },
            text: "Storage quota request",
          },
          data: grantButton,
        },
      },
      bot.webhookSecret,
    );
    expect(res.status).toBe(200);
    expect(getUser(ctx.authDb, carolId)?.quota_mb).toBe(1);
    await waitFor(
      () => tgSends().some((c) => String(c.payload.text).includes("raised to 1 MB")),
      "quota grant user message",
    );

    // a NEW session picks up the raised quota; the blocked write now lands
    const fresh = await mcpClient((await oauthLogin(CAROL)).access);
    const retry = toolText(
      await fresh.callTool({
        name: "update_section",
        arguments: { name: "extra", content: "e".repeat(3000) },
      }),
    );
    expect(retry).toContain("updated");
    await fresh.close();
  });

  it("refuses documents over the per-document cap outright", async () => {
    const client = await mcpClient((await oauthLogin(CAROL)).access);
    const result = toolText(
      await client.callTool({
        name: "update_reference",
        arguments: { name: "huge", content: "h".repeat(1024 * 1024 + 1) },
      }),
    );
    expect(result).toContain("per-document limit");
    await client.close();
  });
});

describe("user-side Telegram: quick capture + notify_user", () => {
  it("appends a linked user's plain text to their journal and confirms", async () => {
    const res = await postWebhook(
      {
        message: {
          message_id: 20,
          chat: { id: CAROL_CHAT, type: "private" },
          text: "Felt strong on today's run, knee was fine",
        },
      },
      bot.webhookSecret,
    );
    expect(res.status).toBe(200);
    const entry = ctx.tenants
      .open(carolId)
      .prepare("SELECT entry FROM journal ORDER BY id DESC LIMIT 1")
      .get() as { entry: string };
    expect(entry.entry).toBe("[via Telegram] Felt strong on today's run, knee was fine");
    const reply = tgSends().at(-1)?.payload as { chat_id: unknown; text: string };
    expect(String(reply.chat_id)).toBe(String(CAROL_CHAT));
    expect(reply.text).toContain("Saved to your coaching journal");
  });

  it("explains itself to unlinked chats and on commands, writing nothing", async () => {
    const before = (
      ctx.tenants.open(carolId).prepare("SELECT COUNT(*) AS n FROM journal").get() as {
        n: number;
      }
    ).n;

    await postWebhook(
      { message: { message_id: 21, chat: { id: 555, type: "private" }, text: "hello?" } },
      bot.webhookSecret,
    );
    const strangerReply = tgSends().at(-1)?.payload as { chat_id: unknown; text: string };
    expect(String(strangerReply.chat_id)).toBe("555");
    expect(strangerReply.text).toContain("not connected");

    await postWebhook(
      { message: { message_id: 22, chat: { id: CAROL_CHAT, type: "private" }, text: "/help" } },
      bot.webhookSecret,
    );
    const helpReply = tgSends().at(-1)?.payload as { text: string };
    expect(helpReply.text).toContain("coaching journal");

    const after = (
      ctx.tenants.open(carolId).prepare("SELECT COUNT(*) AS n FROM journal").get() as {
        n: number;
      }
    ).n;
    expect(after).toBe(before);
  });

  it("registers notify_user only for linked users and delivers to their chat", async () => {
    // admin never linked Telegram — no tool
    const adminClient = await mcpClient((await oauthLogin(ADMIN)).access);
    const adminTools = (await adminClient.listTools()).tools.map((t) => t.name);
    expect(adminTools).not.toContain("notify_user");
    await adminClient.close();

    // carol linked — tool present, message lands in her chat
    const client = await mcpClient((await oauthLogin(CAROL)).access);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("notify_user");
    const result = toolText(
      await client.callTool({
        name: "notify_user",
        arguments: { message: "Weekly check-in: all green — easy week ahead." },
      }),
    );
    expect(result).toContain("delivered");
    const sent = tgSends().at(-1)?.payload as { chat_id: unknown; text: string };
    expect(String(sent.chat_id)).toBe(String(CAROL_CHAT));
    expect(sent.text).toContain("Weekly check-in");
    await client.close();
  });
});
