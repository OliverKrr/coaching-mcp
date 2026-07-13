# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Standalone package — keep it self-contained.** This repo must not reference any specific
> deployment or sibling repo: no hostnames, no domains, no other repo names or paths, no external
> `just`/CI recipes, no "the Raspberry Pi". That includes source, CLI output, tests, and this
> CLAUDE.md. Describe behaviour in terms of this package's own tools/CLIs and use only **generic
> examples**. Deployment-specific wiring belongs in the deployment repo, never here.

## What this repo is

Multi-user coaching MCP server for Claude AI. Serves a `SKILL.md` knowledge base (goals, rules,
personal profile) plus reference documents, a session journal, open items, and stored scheduled
routines — stored in SQLite+FTS5 and exposed as MCP tools over Streamable HTTP. Coaching is
topic-based: installable **topic packs** (training, nutrition, custom) live under
`seed-template/topics/` and are delivered on demand via read-only tools, so each user picks
their own topics during onboarding. v2 is multi-tenant: a built-in OAuth 2.1 authorization
server federates login to an OIDC identity provider (Google by default), membership lives in
auth.db (self-registration with operator approval; `ADMIN_EMAILS` implicitly allowed;
`ALLOWED_EMAILS` as optional pre-approval bootstrap), and every user gets an isolated per-user
database seeded from a generic template, governed by a storage quota. A self-service `/account`
page provides data export and account deletion; `/admin` is the operator console; an optional
Telegram bot (plus a plain `NOTIFY_URL` webhook) delivers signup/quota notifications with
inline approve/grant buttons. The bare `coaching-mcp` command remains the v1-style single-user
stdio server.

## Commands

Use `just` for everything (see `Justfile` for the full list):

```sh
just build        # compile TypeScript (tsdown → dist/)
just test         # vitest run (no external network; OIDC is mocked on 127.0.0.1)
just check        # oxlint + oxfmt --check
just fix          # oxlint + oxfmt --write (auto-format)
just types        # tsc --noEmit
just dev          # tsx src/index.ts (stdio single-user mode)
just update-deps  # ncu -u && npm install
just release X.Y.Z  # version stamp + gate + commit + tag + push + GitHub release (RELEASING.md)
```

Direct npm equivalents if just is not installed: `npm run build|test|check|check:fix|check:types`.

## Architecture

```
src/index.ts        bin `coaching-mcp` — stdio single-user server; `serve` arg dispatches to serve.ts
src/serve.ts        bin path `coaching-mcp serve` — node:http server + router (multi-user mode)
src/mcp-http.ts     /mcp Streamable HTTP endpoint; per-session McpServer bound to the user's DB
src/auth/oauth.ts   OAuth 2.1 AS: RFC 8414 metadata, RFC 7591 DCR, /authorize, /oidc/callback, /token
src/auth/oidc.ts    openid-client wrapper (lazy discovery, PKCE toward the IdP, id_token verify)
src/auth/allowlist.ts  ADMIN_EMAILS + bootstrap ALLOWED_EMAILS / ALLOWED_EMAILS_FILE (file re-read per login) + REGISTRATION toggle
src/auth/db.ts      DATA_DIR/auth.db — users (with membership status/quota/telegram link), clients, pending auth, hashed tokens, web sessions, telegram_links, quota_requests
src/membership.ts   resolveLogin decision tree + status transitions (approve/reject/disable/enable/grantQuota/purgeUser) shared by /admin and Telegram
src/admin.ts        /admin operator console (ADMIN_EMAILS-gated, 404 otherwise, English-only): requests, quotas, users
src/notify.ts       NotifyService: best-effort Telegram + NOTIFY_URL webhook fan-out; never blocks logins/writes
src/telegram.ts     minimal Bot API client; per-boot webhook secret, setWebhook/getMe on boot
src/telegram-webhook.ts  POST /telegram/webhook: secret header + admin-chat check → membership callbacks; /start deep-link linking; quick-capture (linked user's text → journal)
src/quota.ts        storage limits: content_bytes counter access, caps, checkWrite ladder, usage warnings
src/tenancy.ts      TenantManager: DATA_DIR/users/<id>/skill.db, lazy open/cache, delete
src/account.ts      /account router (session + CSRF for all account routes): profile, zip export (fflate), delete
src/account-data.ts /account/data browse & edit: sections/refs/routines (create/edit/delete, optimistic concurrency), journal, open items
src/auth/secrets.ts encrypted per-user secret store (AES-256-GCM under SECRETS_KEY; AAD binds user+slot)
src/integrations/hevy.ts  Hevy API client + MCP tools, registered per-session only for users with a key
src/apps-proxy.ts   /apps/<name> authenticated reverse proxy (per-app email allowlist, HTML prefix rewriting)
src/gateways.ts     per-user MCP gateway: users attach upstream MCP servers on /account; sessions mount their tools verbatim
src/ratelimit.ts    fixed-window per-IP limiter guarding the auth endpoints
src/db.ts           coaching DB schema: sections, refs, journal, open_items, routines, changes + FTS5 (per user)
src/history.ts      change-history delta log: schema, logEdit/logReplace, block diff, retention pruning
src/seed-updates.ts seed-update ledger (SEED_DIR/UPDATES.md) parser + per-user applied-watermark
src/tools/*.ts      the MCP tools — take (server, db); deliberately user-agnostic
src/topics.ts       topic-pack loader (SEED_DIR/topics/<id>/) + list_topic_packs/get_topic_pack
src/snapshot.ts / restore.ts / backup-db.ts + *-cli.ts   operational CLIs
src/http-util.ts    tiny node:http helpers (no express — keep deps lean)
src/web/            page shell for all rendered pages (layout.ts: design tokens, dark mode, session-aware site nav; i18n.ts: sticky EN/DE preference via lang cookie; ui.ts: badge) — still zero JS
seed-template/      generic core SKILL.md + core references + topics/ packs, baked into the image as /seed
```

Seed data flow (per user, first login only): `/seed/SKILL.md` → sections(name='main'),
`/seed/references/*.md` → refs. After that, all writes go through the MCP tools.
`/seed/topics/**` is **never auto-seeded** — packs are delivered by `get_topic_pack` and
instantiated by the assistant through the normal write tools during onboarding.
**Editing `seed-template/` content that onboarded users should receive requires a matching
entry in `seed-template/UPDATES.md` in the same commit** (see "Seed updates propagate
agent-mediated" below) — seeding never re-runs, so the ledger is the only path to existing
users.

`coaching-mcp-restore` (inverse of `coaching-mcp-snapshot`) upserts `sections`/`refs` from a seed
dir into a live DB; it preserves `journal` + `open_items` and has a timestamp clobber guard
(`seed-manifest.json`; conflicts abort unless `--force`; `--dry-run` previews read-only).

`coaching-mcp-backup-db <src> <dest>` makes a consistent, WAL-safe copy of an arbitrary SQLite
file via SQLite's online backup API. Use it for opaque operational DBs the schema-aware snapshot
doesn't cover — notably the auth/registry DB (identity → user-id map + sealed per-user secrets),
which must be backed up alongside per-user snapshots or a restore can't reconstruct users.

## MCP tools

| Tool                                  | Direction | Description                                                                    |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `get_coaching_context`                | read      | Full SKILL.md — call at session start                                          |
| `search_knowledge`                    | read      | FTS5 full-text search (sections, refs, journal, routines)                      |
| `get_section` / `list_sections`       | read      | One section / all sections with metadata                                       |
| `get_reference` / `list_references`   | read      | One reference doc / all references with metadata                               |
| `get_journal`                         | read      | Recent journal entries, newest first                                           |
| `update_section`                      | write     | Create or fully rewrite a knowledge section (use `main` for SKILL.md)          |
| `update_reference`                    | write     | Create or fully rewrite a reference doc                                        |
| `edit_section` / `edit_reference`     | write     | Exact-string replacement inside a doc (old_string must match exactly once)     |
| `append_journal`                      | write     | Append a coaching journal entry                                                |
| `delete_section` / `delete_reference` | write     | Delete a doc (confirm=true; `main` protected; recoverable via change history)  |
| `list_changes` / `get_change`         | read      | Change history: what edits/overwrites/deletes removed — for content recovery   |
| `add_open_item`                       | write     | Record a commitment (if-then next action) or a de-duplicated flag              |
| `list_open_items`                     | read      | List open commitments/flags (defaults to status=open) — call at session start  |
| `resolve_open_item`                   | write     | Close an open item (done/dismissed) with an optional note                      |
| `list_topic_packs` / `get_topic_pack` | read      | Installable coaching topics: interview + skeletons + routine templates         |
| `get_seed_updates`                    | read      | Pending seed-template updates: curated merge instructions for the assistant    |
| `mark_seed_updates_applied`           | write     | Advance the per-user seed-update watermark after merging (partial ok)          |
| `list_routines` / `get_routine`       | read      | Stored scheduled-routine prompts (users copy them into Claude scheduled tasks) |
| `save_routine`                        | write     | Upsert a routine (name, cadence, prompt, status; status kept when omitted)     |
| `delete_routine`                      | write     | Delete a stored routine (confirm=true)                                         |
| `request_quota_increase`              | write     | Ask the operator for more storage with a reason (serve mode, per-session)      |
| `notify_user`                         | write     | Telegram message to the user (per-session, only when their chat is linked)     |
| `get_version`                         | read      | Build info + per-table statistics + storage usage vs. quota                    |

**Every tool registration carries a `title` and MCP tool `annotations`** — connector UIs group
tools by these hints (an unannotated tool lands in a flat "other tools" bucket with the most
pessimistic defaults). Convention: `readOnlyHint: true` for reads; writes always set
`destructiveHint` explicitly (`false` only for purely additive writes like `append_journal` —
document replaces and deletes are `true`); `idempotentHint: true` where a repeat call is a no-op;
`openWorldHint: true` only for tools that talk to an external service (Hevy, Telegram).
`tests/annotations.test.ts` enforces this for every registered tool — gateway-mounted upstream
tools are exempt (their metadata passes through verbatim).

## Environment variables (serve mode)

`PUBLIC_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` required (fail-fast); `OIDC_ISSUER`
(default Google), `ADMIN_EMAILS` (implicitly allowed + gates /admin), `REGISTRATION`
(default open; `closed` = invite-only), `ALLOWED_EMAILS`/`ALLOWED_EMAILS_FILE` (bootstrap,
skips approval), `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ADMIN_CHAT_ID` (+ `TELEGRAM_API_BASE`
tests-only), `NOTIFY_URL`, `QUOTA_DEFAULT_MB` (50), `DATA_DIR` (/data), `SEED_DIR` (/seed),
`PORT` (8000), `ACCESS_TOKEN_TTL` (3600), `REFRESH_TOKEN_TTL` (7776000), change-history
retention `HISTORY_MAX_AGE_DAYS` (90) / `HISTORY_MAX_PER_DOC` (40) / `HISTORY_MAX_BYTES`
(10 MiB). Stdio mode uses only `DATA_DIR`/`SEED_DIR` (+ the `HISTORY_*` retention vars).

## Key design decisions

**FTS5 external content tables**: `sections_fts`, `refs_fts`, `journal_fts`, `routines_fts` are
external-content virtual tables. All four require INSERT + UPDATE + DELETE triggers to stay in
sync with their base tables (`journal_au` arrived with web journal editing in v2.1 — the journal
is append-only over MCP but editable on the account page). Do not remove any trigger from
`db.ts`; because `createSchema()` uses `CREATE TABLE/TRIGGER IF NOT EXISTS` on every open, new
tables and triggers self-apply to existing per-user DBs (this is how v2 DBs gained `routines`).

**Change history is a delta log, captured at two levels**: the per-user `changes` table records
what every write REMOVED (edit → the verbatim old/new strings, overwrite → a block diff of the
previous version, delete → the full old content). Deletes are captured by the `*_hist_ad`
triggers in `db.ts` (same do-not-remove rule as the FTS/bytes trigger families — no code path
can bypass them). Overwrites cannot be diffed in SQL, so **every overwrite path must call
`logReplace` from `src/history.ts` in the same transaction as the write** — currently the write
tools, the edit tools (`logEdit`), the account-data editor, and the restore CLI; keep that list
complete when adding write paths. History rows are deliberately NOT counted in `content_bytes`
(the safety net must not eat the quota) and are bounded instead by `pruneChanges` on every DB
open (`HISTORY_*` env vars). The MCP surface is read-only (`list_changes`/`get_change`);
recovery re-applies content through the normal write tools, and purging history is a
human-only account-page action.

**Seed updates propagate agent-mediated, never mechanically**: seeded documents are
personalized instantiations, so template changes cannot be pushed server-side. The seed dir's
`UPDATES.md` ledger (monotonic integer ids, `Apply: auto|propose`, instructions written FOR the
assistant) is compared against the per-user `meta['seed_updates_applied']` watermark —
**stamped to the latest id inside the seeding transaction**, so fresh users start current and
pre-feature DBs (no key → 0) see every entry exactly once. The protocol is self-carrying:
guidance lives in the `get_coaching_context` pending notice and the `get_seed_updates`
preamble, never in seeded docs (which predate the updates they deliver). No `UPDATES.md` →
feature dormant (tools unregistered — the structural-opt-in pattern). Merges go through the
normal write tools, so change history makes them recoverable.

**Web edits mirror the MCP tool semantics**: the account editor enforces the same rules as the
tools (`main` undeletable, open-item statuses open/done/dismissed, routine statuses
active/paused/retired) and adds an optimistic-concurrency token (`updated_at`) on
section/reference/routine saves so a browser save can never silently clobber a concurrent
coaching-session write.

**Topic packs are read-only content, not a write path**: `list_topic_packs`/`get_topic_pack`
only deliver markdown from `SEED_DIR/topics/`; instantiation happens through the existing
`update_section`/`update_reference`/`save_routine` writes so the assistant tailors skeletons to
the user and everything stays visible in the account editor. Operators customize packs by
mounting their own seed dir.

**Routines are runtime state, like journal/open items**: stored per user, exported and
snapshotted (`routines.md`), never touched by `coaching-mcp-restore` or seeding. Routine
templates are English masters inside topic packs; the stored per-user routine is generated in
the user's language. The server never schedules anything — users paste prompts into scheduled
tasks in their own Claude account, and `status` is bookkeeping for that.

**Seed idempotency**: `seedFromDirectory()` checks `COUNT(*) FROM sections` before seeding — safe
to call on every start. Wrapped in a `db.transaction()` to prevent partial state.

**Per-user SQLite files, not one DB with user columns**: isolation is structural, export is "zip
the directory contents", deletion is "remove the directory", v1 migration is "move the file". The
tool layer receives only a DB handle and must stay user-agnostic — never thread identity into
`src/tools/`.

**Tokens are opaque and stored hashed**: auth codes, access and refresh tokens are random values
whose SHA-256 hashes live in auth.db — possession of the DB yields no usable credential, and
revocation (account deletion, refresh-reuse theft detection) is exact. No JWTs, no signing keys.
Refresh tokens rotate on every use; reuse of a rotated token revokes the user+client chain.

**Login is fully delegated to the IdP**: this server never sees passwords; it verifies the
id_token (issuer, audience, nonce, signature via JWKS — `openid-client`) and applies the
membership check. The OAuth endpoint surface (metadata + DCR + authorize + token, PKCE S256
only) matches what MCP connector clients negotiate.

**Membership lives in auth.db, env lists are bootstrap**: `users.status`
(active/pending/rejected/disabled) is the source of truth; `ADMIN_EMAILS` and the optional
`ALLOWED_EMAILS` bootstrap deliberately _win over_ stored status (lockout recovery — adding an
email there auto-approves). Unknown verified logins become `pending` rows (no tenant DB until
approval, backstop `MAX_PENDING_USERS`); the decision tree is `resolveLogin()` and every status
transition goes through `membership.ts`, shared by `/admin` forms and Telegram callbacks so the
two surfaces can never diverge. Disable revokes all tokens + web sessions in the same call —
never flip status without the side effects.

**Telegram is an optional convenience layer, never load-bearing**: all notifications are
fire-and-forget (a failed send is logged, never breaks a login or write) and `/admin` can do
everything the buttons can. Webhook auth is two-layered: a per-boot random `secret_token`
announced via `setWebhook` (no persisted secret) proves the sender is Telegram, and membership
actions additionally require `callback_query.from.id` to equal `TELEGRAM_ADMIN_CHAT_ID`.
User-side messages are strictly opt-in via `/start` deep-link tokens (stored hashed, single
use) — bots cannot initiate chats, and this design keeps it that way. Once linked, the channel
carries three things: server notifications, the per-session `notify_user` tool (registered only
for linked users, daily budget `TELEGRAM_NOTIFY_PER_DAY`), and **quick capture** — a linked
active user's plain text becomes a `[via Telegram] …` journal entry (LLM-free, quota-checked,
`TELEGRAM_CAPTURES_PER_HOUR` budget); everything else gets a short explanatory reply, never
silence. The seeded coaching-method reference instructs the assistant to mirror routine pushes
via `notify_user` when present and never mention it when absent.

**Quotas count stored content, transactionally**: the per-user `meta.content_bytes` counter is
maintained by `*_bytes_*` triggers (same pattern as the FTS triggers — do not remove them) and
recomputed on every DB open, so drift self-heals and pre-quota DBs initialize themselves. Write
tools take an optional `WriteLimits` (quota bytes + rate budget) — identity never enters
`src/tools/`; stdio mode passes none and stays unlimited. `request_quota_increase` is
registered per-session in `mcp-http.ts` (needs identity + notifier — the integrations pattern).
The refusal ladder is rate → per-doc cap → quota, shrinking writes always pass, and the
account-page editor mirrors the same checks minus the rate limit.

**No express**: the HTTP layer is plain `node:http` + ~100 lines of helpers (`http-util.ts`);
the MCP SDK's `StreamableHTTPServerTransport` consumes Node req/res directly. Keep it that way —
the dependency budget of this package is deliberately small.

**All advertised URLs come from `PUBLIC_URL`**: routes mount at `/` behind a prefix-stripping
reverse proxy; never build absolute URLs from Host headers. HTML forms/links on the account page
must use absolute `PUBLIC_URL`-based URLs for the same reason.

**Clobber guard (snapshot/restore)**: `coaching-mcp-snapshot` writes `seed-manifest.json` (raw
SQLite `datetime('now')` strings — fixed-width UTC, string compare = chronological); the `.md`
files stay byte-identical to DB `content`. `coaching-mcp-restore` treats content changes where
live `updated_at` is newer than the manifest as conflicts: abort-all unless `--force`;
`--dry-run` reports `STALE SEED` but exits 0. No manifest → legacy mode (guard off, warns).

**User secrets are sealed, not just stored**: AES-256-GCM under `SECRETS_KEY` with the
`userId:name` pair as AAD — a leaked auth.db yields nothing and a ciphertext cannot be replayed
onto another user or slot. Secrets are never logged and never rendered back (the UI shows only
"connected since"). Integration tools register per session, only for users with a stored key —
opt-in is structural, not a permission check inside the tool.

**Pages contain zero JavaScript, and CSP enforces it**: `script-src 'none'` on every rendered
page. Never add inline handlers (`onsubmit=` etc.) — if a page ever needs JS, the CSP decision
has to be revisited deliberately. Proxied app responses keep their own headers.

**Gateway passthrough is verbatim and protocol-level (pinned SDK internals)**: upstream tools
must reach Claude with their exact JSON schemas and annotations — a curated upstream's
per-endpoint guidance is its value. Tool names get a mandatory per-server prefix (derived from
the gateway name, unique per user) and descriptions/titles a "Server: " attribution, so every
tool stays traceable to its server in tool lists and permission UIs. `registerTool` is zod-only in SDK 1.29 and would
re-serialize schemas, so `attachGatewayTools` wraps the underlying `Server`'s stored `tools/list`
and `tools/call` handlers (private `_requestHandlers` / `_registeredTools`, guarded by a test
that fails loudly on SDK upgrades). Gateway URLs are SSRF-guarded (https-only, no
private/internal targets, re-checked per request and per redirect hop;
`GATEWAY_ALLOW_INSECURE=1` relaxes this for 127.0.0.1 mock upstreams in tests only). Upstream
credentials (OAuth tokens, DCR client info, static bearer) live in the sealed per-user secret
store; a failed upstream is skipped for the session and surfaced on the account page, never
breaking coaching.

**App proxy authorization is allowlist-per-app**: a Google login alone must never expose a
protected app; the user's email must be on that app's own list (`PROTECTED_APP_<NAME>_EMAILS`).

**Prepared statements**: SQL statements used in loops are hoisted outside the loop.

**tsdown + fixedExtension**: output is `dist/*.js` (not `.mjs`), matching `bin` entries.

**Tests never touch the network**: `tests/serve.test.ts` runs a mock OIDC issuer on 127.0.0.1
(RS256 JWKS, authorize/token endpoints) and drives the full redirect chain with `fetch`; MCP
round-trips use the SDK's Streamable HTTP client against the in-process server.
