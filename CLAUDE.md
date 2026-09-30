# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## Keep the package self-contained

coaching-mcp is a standalone public package that operators deploy on their own infrastructure.
Write source, CLI output, tests, docs and this file in terms of the package's own tools and CLIs,
with generic examples only (`example.com`, `/data/users/<id>/skill.db`). Hostnames, domains, other
repo names or paths, external `just`/CI recipes and descriptions of any particular host belong in
the deployment repo that consumes this package.

## What this is

A multi-user coaching MCP server for Claude. Each user's knowledge base (a `SKILL.md` "main"
section plus references, journal, open items, metrics and stored routines) lives in its own
SQLite+FTS5 database under `DATA_DIR/users/<id>/skill.db` and is exposed as MCP tools over
Streamable HTTP. A built-in OAuth 2.1 authorization server federates login to an OIDC provider
(Google by default); membership, tokens and sealed per-user secrets live in `DATA_DIR/auth.db`.
Coaching topics are installable topic packs under `seed-template/topics/`. The bare `coaching-mcp`
command is a single-user stdio server; `coaching-mcp serve` is the multi-user HTTP server.

## Commands

```sh
just build          # tsdown → dist/
just test           # vitest run; no network, OIDC is mocked on 127.0.0.1
just check          # oxlint + oxfmt --check
just fix            # oxlint + oxfmt --write
just types          # tsc --noEmit
just dev            # stdio single-user server via tsx
just serve          # multi-user HTTP server via tsx (needs PUBLIC_URL and OIDC_* env)
just snapshot [dir] # build, then snapshot the local DB (default ./snapshots)
just docker-build   # local image
just update-deps    # npm-check-updates -u && npm install
just release X.Y.Z  # stamp, gate, commit, tag, push, GitHub release (RELEASING.md)
```

Without `just`: `npm run build|test|check|check:fix|check:types|dev`. Before calling a change
done, run `just check`, `just types` and `just test`; `just release` runs the same gate and aborts
on any failure.

The version lives in both `package.json` and `src/version.ts`. Let `just release` stamp them
rather than editing either by hand, because a mismatch between them has happened before.

## Finding things

- Entry points: `src/index.ts` is the `coaching-mcp` bin and hands the `serve` argument to
  `src/serve.ts`; `src/cli-main.ts` is `coaching-cli`; the other bins are `src/*-cli.ts`. The
  `bin` map in `package.json` is authoritative.
- Current tool list with descriptions:
  `SEED_DIR=seed-template npx tsx src/cli-main.ts --db <scratch dir> tools`. It omits the
  per-session tools registered in `src/mcp-http.ts` (`request_quota_increase`, `notify_user`,
  `refresh_connected_servers`, the Hevy and Intervals.icu tools from `src/integrations/`, and
  gateway-mounted upstream tools).
- Environment variables: the table in `README.md` ("Environment variables (serve mode)"). It
  leaves out only `TELEGRAM_API_BASE`, which exists for tests. Stdio mode reads only `DATA_DIR`, `SEED_DIR`, the `HISTORY_*` vars and
  `INDEX_BUDGET_BYTES`. Tuning values such as `MAX_SESSIONS_TOTAL` and the heap thresholds are
  constants in `src/mcp-http.ts` and `src/serve.ts`, not env vars.
- Operator-facing docs: `README.md`. Release steps: `RELEASING.md`.

## Conventions

**Tools**

- Give every tool registration a `title` and MCP `annotations`, because connector UIs group
  tools by them and an unannotated tool lands in a flat "other tools" bucket with pessimistic
  defaults. Reads set `readOnlyHint: true`. Writes set `destructiveHint` explicitly: `false` only
  for purely additive writes like `append_journal`, `true` for replaces and deletes.
  `idempotentHint: true` where a repeat call is a no-op; `openWorldHint: true` only for tools that
  call an external service. `tests/annotations.test.ts` checks every registered tool except
  gateway-mounted upstream tools, whose metadata passes through verbatim.
- Add core tools to `registerCoreTools` in `src/register.ts`. Stdio, HTTP sessions and
  `coaching-cli` all build from that one list, so the three stay identical.
- Keep `src/tools/` user-agnostic: a tool gets `(server, db)` and optional `WriteLimits`, never a
  user id. Tools that need identity or the notifier register per session in `src/mcp-http.ts`.
  Per-user isolation is structural (one DB file per user), and threading identity into tools
  would undo that.
- Features that depend on configuration register their tools only when the configuration exists
  (a stored API key, a linked Telegram chat, a `SEED_DIR/UPDATES.md`), instead of checking inside
  the tool.

**Writes and history**

- Every path that overwrites a document calls `logReplace` (or `logEdit` for exact-string edits)
  from `src/history.ts` in the same transaction as the write. Deletes are captured by triggers,
  but overwrites can't be diffed in SQL, so a new write path that skips this loses the only
  recovery copy. Current callers: `src/tools/write.ts`, `src/tools/edit.ts`,
  `src/tools/routines.ts`, `src/account-data.ts`, `src/restore.ts`.
- Write to a coaching DB through the tool handlers (or `coaching-cli call`), not raw SQL. FTS
  sync is triggers, but change-history diffs and seed semantics live in application code.
- The journal is append-only over MCP: fixes go through `correct_journal`, and every read path
  renders the correction next to the entry. Render entries with the shared helpers in
  `src/utils/journal.ts`, and call them through an arrow (`(r) => journalListed(r)`), because
  their optional cap parameter turns an `Array.map` index into a length cap.
- A metric series is `state` or `event`, fixed at first use. Keep it fixed. `state` reads return
  the current value by validity window and `event` reads count rows, so a series that switched
  kind would answer both kinds of question wrong.
- Hoist prepared statements used in loops out of the loop.
- Schema and trigger rules load from `.claude/rules/schema.md` when you open `src/db.ts`,
  `src/history.ts` or `src/quota.ts`.

**Auth, membership, notifications**

- Change a user's status only through the transitions in `src/membership.ts`. `/admin` and the
  Telegram buttons share them, and disabling a user revokes all tokens and web sessions in the
  same call; flipping `users.status` directly skips that.
- Tokens are random values stored as SHA-256 hashes; don't introduce JWTs or signing keys.
- Never log or render a user secret back. The account page shows only "connected since".
- Telegram and `NOTIFY_URL` sends are fire-and-forget. A failed notification is logged and never
  fails a login or a write.

**HTTP and runtime**

- Use plain `node:http` and the helpers in `src/http-util.ts`. The dependency set is kept small
  on purpose, so no express or similar framework.
- Build advertised and page URLs from `PUBLIC_URL`, never from the Host header. The server runs
  behind a prefix-stripping proxy.
- Tear MCP sessions down through `dispose()` in `src/mcp-http.ts`. Removing a session from the map
  directly leaks its upstream gateway connections.
- `/health` is public: add counts to it, never identities.
- The `main` index budget (`INDEX_BUDGET_BYTES`) is a warning, not a cap. Keep it that way; a
  cap would refuse writes mid-session.

**Build and tests**

- tsdown runs with `fixedExtension: false`, so output is `dist/*.js` (not `.mjs`) to match the
  `bin` entries.
- Tests never touch the network. `tests/serve.test.ts` runs a mock OIDC issuer on 127.0.0.1 and
  drives the redirect chain with `fetch`; MCP round-trips use the SDK's Streamable HTTP client
  against the in-process server. Mock new external services the same way on 127.0.0.1.

## Seed data

New users are seeded once, on first login: `/seed/SKILL.md` becomes section `main`,
`/seed/references/*.md` become references. After that every write goes through the tools.
`seed-template/` is end-user product content; `.claude/rules/seed-template.md` loads when you open
a file there and covers the `UPDATES.md` ledger that template changes need.

## Design rationale

`docs/design-decisions.md` holds the reasoning behind the non-obvious mechanisms, one section per
decision. Read the matching section before you:

- change the schema, triggers, change history, quotas or the journal/metrics model;
- change what `start_session` returns or how its byte budgets trim it;
- touch login, tokens, membership, Telegram linking or the secret store;
- change MCP session lifecycle, eviction, `/health` or the heap detector;
- change gateway passthrough or caching, or the `/apps` proxy;
- change snapshot, restore or backup behaviour;
- propose replacing one of these designs (a JWT, a per-user session cap, a shared DB, an HTTP
  framework, page JavaScript).

Directory-specific rules for rendered pages and for gateways/the app proxy load automatically from
`.claude/rules/` when you open files they cover.
