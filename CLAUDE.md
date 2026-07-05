# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Standalone package — keep it self-contained.** This repo must not reference any specific
> deployment or sibling repo: no hostnames, no domains, no other repo names or paths, no external
> `just`/CI recipes, no "the Raspberry Pi". That includes source, CLI output, tests, and this
> CLAUDE.md. Describe behaviour in terms of this package's own tools/CLIs and use only **generic
> examples**. Deployment-specific wiring belongs in the deployment repo, never here.

## What this repo is

Multi-user coaching MCP server for Claude AI. Serves a `SKILL.md` knowledge base (goals, rules,
athlete profile) plus reference documents, a session journal, and open items — stored in
SQLite+FTS5 and exposed as MCP tools over Streamable HTTP. v2 is multi-tenant: a built-in OAuth
2.1 authorization server federates login to an OIDC identity provider (Google by default), an
email allowlist gates access, and every user gets an isolated per-user database seeded from a
generic template. A self-service `/account` page provides data export and account deletion.
The bare `coaching-mcp` command remains the v1-style single-user stdio server.

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
```

Direct npm equivalents if just is not installed: `npm run build|test|check|check:fix|check:types`.

## Architecture

```
src/index.ts        bin `coaching-mcp` — stdio single-user server; `serve` arg dispatches to serve.ts
src/serve.ts        bin path `coaching-mcp serve` — node:http server + router (multi-user mode)
src/mcp-http.ts     /mcp Streamable HTTP endpoint; per-session McpServer bound to the user's DB
src/auth/oauth.ts   OAuth 2.1 AS: RFC 8414 metadata, RFC 7591 DCR, /authorize, /oidc/callback, /token
src/auth/oidc.ts    openid-client wrapper (lazy discovery, PKCE toward the IdP, id_token verify)
src/auth/allowlist.ts  ALLOWED_EMAILS / ALLOWED_EMAILS_FILE (file re-read per login attempt)
src/auth/db.ts      DATA_DIR/auth.db — users, clients, pending auth, hashed tokens, web sessions
src/tenancy.ts      TenantManager: DATA_DIR/users/<id>/skill.db, lazy open/cache, delete
src/account.ts      /account router (session + CSRF for all account routes): profile, zip export (fflate), delete
src/account-data.ts /account/data browse & edit: sections/refs (create/edit/delete, optimistic concurrency), journal, open items
src/auth/secrets.ts encrypted per-user secret store (AES-256-GCM under SECRETS_KEY; AAD binds user+slot)
src/integrations/hevy.ts  Hevy API client + MCP tools, registered per-session only for users with a key
src/apps-proxy.ts   /apps/<name> authenticated reverse proxy (per-app email allowlist, HTML prefix rewriting)
src/ratelimit.ts    fixed-window per-IP limiter guarding the auth endpoints
src/db.ts           coaching DB schema: sections, refs, journal, open_items + FTS5 (per user)
src/tools/*.ts      the 10 MCP tools — take (server, db); deliberately user-agnostic
src/snapshot.ts / restore.ts / migrate.ts + *-cli.ts   operational CLIs
src/http-util.ts    tiny node:http helpers (no express — keep deps lean)
seed-template/      generic SKILL.md + reference skeletons, baked into the image as /seed
```

Seed data flow (per user, first login only): `/seed/SKILL.md` → sections(name='main'),
`/seed/references/*.md` → refs. After that, all writes go through the MCP tools.

`coaching-mcp-restore` (inverse of `coaching-mcp-snapshot`) upserts `sections`/`refs` from a seed
dir into a live DB; it preserves `journal` + `open_items` and has a timestamp clobber guard
(`seed-manifest.json`; conflicts abort unless `--force`; `--dry-run` previews read-only).
`coaching-mcp-migrate` adopts a v1 single-user `DATA_DIR/skill.db` into the multi-user layout.

## MCP tools

| Tool                   | Direction | Description                                                                   |
| ---------------------- | --------- | ----------------------------------------------------------------------------- |
| `get_coaching_context` | read      | Full SKILL.md — call at session start                                         |
| `search_knowledge`     | read      | FTS5 full-text search across all tables                                       |
| `get_reference`        | read      | One reference doc by name                                                     |
| `get_journal`          | read      | Recent journal entries, newest first                                          |
| `update_section`       | write     | Upsert a knowledge section (use `main` for SKILL.md)                          |
| `update_reference`     | write     | Upsert a reference doc                                                        |
| `append_journal`       | write     | Append a coaching journal entry                                               |
| `add_open_item`        | write     | Record a commitment (if-then next action) or a de-duplicated flag             |
| `list_open_items`      | read      | List open commitments/flags (defaults to status=open) — call at session start |
| `resolve_open_item`    | write     | Close an open item (done/dismissed) with an optional note                     |

## Environment variables (serve mode)

`PUBLIC_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` required (fail-fast); `OIDC_ISSUER`
(default Google), `ALLOWED_EMAILS`/`ALLOWED_EMAILS_FILE`, `DATA_DIR` (/data), `SEED_DIR` (/seed),
`PORT` (8000), `ACCESS_TOKEN_TTL` (3600), `REFRESH_TOKEN_TTL` (7776000). Stdio mode uses only
`DATA_DIR`/`SEED_DIR`.

## Key design decisions

**FTS5 external content tables**: `sections_fts`, `refs_fts`, `journal_fts` are external-content
virtual tables. All three require INSERT + UPDATE + DELETE triggers to stay in sync with their
base tables (`journal_au` arrived with web journal editing in v2.1 — the journal is append-only
over MCP but editable on the account page). Do not remove any trigger from `db.ts`; because
`createSchema()` uses `CREATE TRIGGER IF NOT EXISTS` on every open, new triggers self-apply to
existing per-user DBs.

**Web edits mirror the MCP tool semantics**: the account editor enforces the same rules as the
tools (`main` undeletable, open-item statuses open/done/dismissed) and adds an
optimistic-concurrency token (`updated_at`) on section/reference saves so a browser save can
never silently clobber a concurrent coaching-session write.

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
id_token (issuer, audience, nonce, signature via JWKS — `openid-client`) and applies the email
allowlist. The OAuth endpoint surface (metadata + DCR + authorize + token, PKCE S256 only)
matches what MCP connector clients negotiate.

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

**App proxy authorization is allowlist-per-app**: a Google login alone must never expose a
protected app; the user's email must be on that app's own list (`PROTECTED_APP_<NAME>_EMAILS`).

**Prepared statements**: SQL statements used in loops are hoisted outside the loop.

**tsdown + fixedExtension**: output is `dist/*.js` (not `.mjs`), matching `bin` entries.

**Tests never touch the network**: `tests/serve.test.ts` runs a mock OIDC issuer on 127.0.0.1
(RS256 JWKS, authorize/token endpoints) and drives the full redirect chain with `fetch`; MCP
round-trips use the SDK's Streamable HTTP client against the in-process server.
