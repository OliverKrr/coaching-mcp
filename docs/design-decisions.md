# Design decisions

The reasons behind choices a reader can't see in the code. `CLAUDE.md` carries the short rules;
this file carries why they hold, so read the matching section before changing that mechanism or
arguing that it should work differently.

## Storage and schema

### Per-user SQLite files, not one DB with user columns

Isolation is structural, export is "zip the directory contents", deletion is "remove the
directory", v1 migration is "move the file". The tool layer receives only a DB handle and must
stay user-agnostic, so identity never enters `src/tools/`.

### FTS5 external content tables

`sections_fts`, `refs_fts`, `journal_fts` and `routines_fts` are external-content virtual tables.
All four need INSERT + UPDATE + DELETE triggers to stay in sync with their base tables
(`journal_au` exists because the journal, append-only over MCP, is editable on the account page).

`journal_fts` indexes two columns (`entry, correction`). Its whole trigger family, the quota
counters and the delete-capture trigger live in one `JOURNAL_INDEX_SQL` string, because widening
it was not expressible as `CREATE ... IF NOT EXISTS`: an FTS5 table cannot gain a column and a
trigger body cannot be altered. So `migrateJournalIndex` drops and recreates the family once and
`rebuild`s the index from the base table. Any further change to what the journal indexes goes the
same way: edit the shared string, extend the migration probe.

`createSchema()` runs `CREATE TABLE/TRIGGER IF NOT EXISTS` on every open, so new tables and
triggers self-apply to existing per-user DBs (this is how older DBs gained `routines` and
`metrics`). Column additions have no IF NOT EXISTS, so `createSchema()` probes
`pragma table_info` before `ALTER TABLE ADD COLUMN` (how `open_items` gained `resolved_note`);
new columns land at the end of the column list.

The `metrics` table is deliberately outside FTS (structured, queried by name) and outside change
history (a measurement log, not authored prose); its `*_bytes_*` triggers count
`name`+`unit`+`note` toward the quota.

### Change history is a delta log, captured at two levels

The per-user `changes` table records what every write REMOVED: edit → the verbatim old/new
strings, overwrite → a block diff of the previous version, delete → the full old content.
Deletes are captured by the `*_hist_ad` triggers in `db.ts`, so no code path can bypass them.
Overwrites cannot be diffed in SQL, so every overwrite path calls `logReplace` (or `logEdit`)
from `src/history.ts` in the same transaction as the write. Today that is `src/tools/write.ts`,
`src/tools/edit.ts`, `src/tools/routines.ts`, `src/account-data.ts` and `src/restore.ts`.
Databases predating the `script` change kind get their `changes.kind` CHECK rebuilt once on open
(`migrateChangesKindCheck`).

History rows are deliberately NOT counted in `content_bytes` (the safety net must not eat the
quota) and are bounded instead by `pruneChanges` on every DB open (`HISTORY_MAX_AGE_DAYS` 90,
`HISTORY_MAX_PER_DOC` 40, `HISTORY_MAX_BYTES` 10 MiB). The MCP surface is read-only
(`list_changes`/`get_change`); recovery re-applies content through the normal write tools, and
purging history is a human-only account-page action.

### Quotas count stored content, transactionally

The per-user `meta.content_bytes` counter is maintained by `*_bytes_*` triggers (same pattern as
the FTS triggers) and recomputed on every DB open, so drift self-heals and pre-quota DBs
initialize themselves. Write tools take an optional `WriteLimits` (quota bytes + rate budget),
so identity never enters `src/tools/`; stdio mode passes none and stays unlimited.
`request_quota_increase` is registered per-session in `mcp-http.ts` because it needs identity and
the notifier (the integrations pattern). The refusal ladder is rate → per-doc cap → quota,
shrinking writes always pass, and the account-page editor mirrors the same checks minus the rate
limit.

### Seed idempotency

`seedFromDirectory()` checks `COUNT(*) FROM sections` before seeding, so it is safe to call on
every start. It runs inside a `db.transaction()` to prevent partial state.

### The script store is retired (v3)

Analysis code lives in the assistant's own environment (a versioned repository), not in the
coaching DB; the server keeps data exports and durable _results_ (journal, metrics, references).
`migrateDropScripts` retires v2 databases on open without losing content: every stored script
lands in change history as a `script` delete record (recoverable via `list_changes`/`get_change`
for the retention window), then the table, FTS index and all seven trigger family members are
dropped and the quota recomputes. The `changes.kind` CHECK and the history tools keep accepting
`script` so legacy history stays readable.

## Journal and metrics

### The journal is append-only; corrections attach, archiving bounds cost

An entry must still read exactly as written a year later, so there is no journal delete tool and
no rewrite path over MCP. The two problems that creates are solved without touching stored text.

A wrong entry gets `correct_journal`, which writes the `correction` column and is rendered by
every read path (`journalListed`/`journalHeadline`/`journalFull` in `src/utils/journal.ts`, plus
the search-hit `correction` field and the account pages). The invariant is that no path returns a
corrected entry alone. That is why the renderers are shared rather than reimplemented per tool,
and why a correction is never truncated outside search snippets.

Growth is the second problem: the journal loads at every session start, so `archive_journal` sets
`archived_at` and archived entries collapse to headlines there and in `get_journal` listings,
while `get_journal ids:[…]` still returns them in full and the FTS index is untouched. Archiving
costs nothing in findability, which is the whole reason old entries are worth keeping. Archive
only what has already been condensed into a reference; the flag is a load-time decision, never a
retention one.

Archiving is curation and curation gets forgotten, so the mechanical half sits next to it:
`start_session` caps each inlined entry body at `JOURNAL_INLINE_MAX` (1200 chars) with a marker
naming `get_journal ids:[…]`, the same shape as the open-item cap. Together they bound the payload
by construction: count (`journal_full`), per-entry size (the cap), and curation (the flag). The
cap never touches a correction, because a truncated correction would restore exactly the
statement it overrules.

The optional cap parameter on these renderers is a trap: pass one to `Array.map` directly and the
index becomes the cap (caught in review by a two-entry listing test). Call them through an arrow.

### Metric series are 'state' or 'event', and the two must never be conflated

In a plain append log a changed fact sits next to its old value and the two compete at read time.
A `state` series (FTP, thresholds, baselines) closes the previous row's validity window on every
recording: `get_metrics` returns exactly the current value, `as_of` answers "what was it then?",
`include_superseded` shows the trail. An `event` series (weekly volume, adherence) never
supersedes, so counting questions keep working. Kind is set on first use and fixed
(`metric_series` registry; windows are rebuilt idempotently per write/delete, recompute over
increment). `stale_after_days` on a state series makes `start_session` flag an overdue value, a
retest reminder that lives in schema, not prose.

## Session payload budgets

### The index budget is a warning, never a cap

`main` is loaded in full on every session start, so its size is fixed per-session overhead.
`start_session` and `get_coaching_context` lead with a `[hub] main: … B of … B index budget` line
(`INDEX_BUDGET_BYTES`, default 30,000) that turns into an over-budget warning pointing at
`section_outline`; `get_version` reports `main_bytes` + `largest_documents`. A hard cap would
break writes mid-session, which is worse than a large index. The budget makes the cost visible;
the model and user decide what moves out.

### Everything besides `main` in `start_session` fits a hard byte budget

`SESSION_EXTRAS_BUDGET_BYTES` (12,000, `src/tools/session.ts`) covers open items plus the journal
slice, so a full-scope payload is `main` plus at most that. Clients cap tool output in tokens and
spill an oversized result to a file the model then reads back in pieces, and dense non-English
markdown measured about 2 bytes per token, so a byte count that looks safe can still cross a
client's token cap. `fitSessionExtras` walks a ladder, cheapest loss first: demote full journal
entries to headlines (oldest first), shorten item bodies (500 → 200 → 80 chars), drop the oldest
headlines. Open items are never dropped, and a trimmed payload opens with a `[budget]` line naming
what was cut. Unlike the index budget this one is a cap, because it only shapes a read; no write
is refused.

## Tool surfaces and content

### `coaching-cli` drives the real handlers, never raw SQL

The CLI builds the same McpServer as stdio mode and talks to it over the SDK's linked in-memory
transports, so a shell write keeps FTS sync, change history and seed semantics. Overwrite diffs
live in application code, not triggers, and a direct SQL write would silently skip them. It
exists for shell-native callers (agents included): discovery via `tools` / `tool <name>`,
execution via `call <name> '<json>'`, no server, no OAuth, no tool definitions in anyone's
context. `registerCoreTools` is the single shared tool list, so the three surfaces (stdio, HTTP
session, CLI) can never drift.

### Tool usage is counted, never inspected

Every session's final `tools/call` handler is wrapped (`instrumentToolCalls`, installed after
`attachGatewayTools` so native, integration and gateway-proxied calls count through one choke
point, the same pinned-SDK-internals pattern as the gateway passthrough) into per-day aggregated
counters in auth.db (`tool_usage(day, user_id, tool, calls, errors, empty)`, pruned past
`TOOL_USAGE_MAX_AGE_DAYS`, default 180). Counts-only is a privacy line: arguments and results are
user content and never reach the operator. `search_knowledge` splits by scope
(`search_knowledge:journal` etc.) and counts zero-hit results in `empty`, the retrieval-miss log
that decides whether semantic search is ever justified. `/admin` renders the 90-day summary; a
recording failure never breaks a tool call. Tools that never appear are the reduction candidates;
removal itself stays a deliberate, versioned change.

### Seed updates propagate agent-mediated, never mechanically

Seeded documents are personalized instantiations, so template changes cannot be pushed
server-side. The seed dir's `UPDATES.md` ledger (monotonic integer ids, `Apply: auto|propose`,
instructions written FOR the assistant) is compared against the per-user
`meta['seed_updates_applied']` watermark. The watermark is stamped to the latest id inside the
seeding transaction, so fresh users start current and pre-feature DBs (no key → 0) see every
entry exactly once. The protocol is self-carrying: guidance lives in the `get_coaching_context`
pending notice and the `get_seed_updates` preamble, never in seeded docs (which predate the
updates they deliver). No `UPDATES.md` → feature dormant (tools unregistered, the
structural-opt-in pattern). Merges go through the normal write tools, so change history makes
them recoverable.

### Topic packs are read-only content, not a write path

`list_topic_packs`/`get_topic_pack` only deliver markdown from `SEED_DIR/topics/`; `/seed/topics/**`
is never auto-seeded. Instantiation happens through the existing
`update_section`/`update_reference`/`save_routine` writes, so the assistant tailors skeletons to
the user and everything stays visible in the account editor. Operators customize packs by mounting
their own seed dir.

### Routines are runtime state, like journal and open items

Stored per user, exported and snapshotted (`routines.md`), never touched by
`coaching-mcp-restore` or seeding. Routine templates are English masters inside topic packs; the
stored per-user routine is generated in the user's language. The server never schedules anything:
users paste prompts into scheduled tasks in their own Claude account, and `status` is bookkeeping
for that.

### Web edits mirror the MCP tool semantics

The account editor enforces the same rules as the tools (`main` undeletable, open-item statuses
open/done/dismissed, routine statuses active/paused/retired) and adds an optimistic-concurrency
token (`updated_at`) on section/reference/routine saves, so a browser save can never silently
clobber a concurrent coaching-session write.

## Auth, membership, secrets

### Tokens are opaque and stored hashed

Auth codes, access and refresh tokens are random values whose SHA-256 hashes live in auth.db.
Possession of the DB yields no usable credential, and revocation (account deletion, refresh-reuse
theft detection) is exact. No JWTs, no signing keys. Refresh tokens rotate on every use; reuse of
a rotated token revokes the user+client chain.

### Login is fully delegated to the IdP

This server never sees passwords. It verifies the id_token (issuer, audience, nonce, signature
via JWKS through `openid-client`) and applies the membership check. The OAuth endpoint set
(metadata + DCR + authorize + token, PKCE S256 only) matches what MCP connector clients negotiate.

### Membership lives in auth.db, env lists are bootstrap

`users.status` (active/pending/rejected/disabled) is the source of truth. `ADMIN_EMAILS` and the
optional `ALLOWED_EMAILS` bootstrap deliberately _win over_ stored status, for lockout recovery:
adding an email there auto-approves. Unknown verified logins become `pending` rows (no tenant DB
until approval, backstop `MAX_PENDING_USERS` in `src/membership.ts`). The decision tree is
`resolveLogin()`, and every status transition goes through `membership.ts`, shared by `/admin`
forms and Telegram callbacks so the two surfaces can never diverge. Disable revokes all tokens +
web sessions in the same call.

### Telegram is an optional convenience layer, never load-bearing

All notifications are fire-and-forget (a failed send is logged, never breaks a login or write)
and `/admin` can do everything the buttons can. Webhook auth is two-layered: a per-boot random
`secret_token` announced via `setWebhook` (no persisted secret) proves the sender is Telegram, and
membership actions additionally require `callback_query.from.id` to equal
`TELEGRAM_ADMIN_CHAT_ID`.

User-side messages are strictly opt-in via `/start` deep-link tokens (stored hashed, single use);
bots cannot initiate chats, and this design keeps it that way. Once linked, the channel carries
three things: server notifications, the per-session `notify_user` tool (registered only for
linked users, daily budget `TELEGRAM_NOTIFY_PER_DAY` in `src/quota.ts`), and quick capture: a
linked active user's plain text becomes a `[via Telegram] …` journal entry (LLM-free,
quota-checked, `TELEGRAM_CAPTURES_PER_HOUR` budget). Everything else gets a short explanatory
reply, never silence. The seeded coaching-method reference instructs the assistant to mirror
routine pushes via `notify_user` when present and never mention it when absent.

### User secrets are sealed, not just stored

AES-256-GCM under `SECRETS_KEY` with the `userId:name` pair as AAD: a leaked auth.db yields
nothing and a ciphertext cannot be replayed onto another user or slot. Secrets are never logged
and never rendered back (the UI shows only "connected since"). Integration tools register per
session, only for users with a stored key, so opt-in is structural, not a permission check inside
the tool.

## HTTP server and runtime

### No express

The HTTP layer is plain `node:http` + ~100 lines of helpers (`http-util.ts`); the MCP SDK's
`StreamableHTTPServerTransport` consumes Node req/res directly. The dependency budget of this
package is deliberately small.

### All advertised URLs come from `PUBLIC_URL`

Routes mount at `/` behind a prefix-stripping reverse proxy, so a Host header does not tell the
server its external path. HTML forms and links on the account page use absolute
`PUBLIC_URL`-based URLs for the same reason.

### Pages contain zero JavaScript, and CSP enforces it

`script-src 'none'` on every rendered page. Inline handlers (`onsubmit=` etc.) would be blocked;
if a page ever needs JS, the CSP decision has to be revisited deliberately. Proxied app responses
keep their own headers.

### MCP sessions expire on their own clock; `transport.onclose` is never the bound

Real connector clients abandon sessions without sending the spec's `DELETE`, so nothing external
frees them. Each session is expensive (an `McpServer` with every tool registered plus one live
upstream client per attached gateway), so `McpSessionManager` stamps `lastSeen` on every request
and reaps: an idle sweeper (`SESSION_IDLE_TIMEOUT_MS`, timer runs only while sessions exist) plus
one server-wide ceiling (`MAX_SESSIONS_TOTAL`) enforced when a session opens. Both are constants
in `src/mcp-http.ts`. Every teardown path goes through `dispose()`: dropping a session from the
map without closing its gateway clients leaks connections with no session left to account for
them. Without this the process climbs to the V8 heap ceiling over days and then spends every core
in mark-compact GC: still "up", still passing a TCP check, answering trivial requests seconds
late.

### No per-user session cap; contention is resolved by fair share

A fixed per-user limit punishes a single user on an otherwise idle server while doing nothing to
make contention fair. Instead one user may use the whole budget when nobody else needs it, and
once `MAX_SESSIONS_TOTAL` is exceeded `pickFairShareVictim` takes the least recently used session
from whoever holds the most. That converges on max-min fairness with no configuration: a user
holding one session is never evicted while another holds two, a client looping on initialize only
evicts itself, and when all users hold an equal share it degrades to global LRU. The victim
selection is a pure exported function so the fairness properties are unit-testable without
standing up dozens of real sessions. Size the ceiling by `sessions × ~3 MB` (measured, with one
gateway mounted) against the deployed heap.

### Runtime state is observable without a repro

`/health` carries deliberately non-identifying counters (`sessions`, `gateways`,
`heap_used_mb`/`heap_limit_mb`/`heap_pct`, `rss_mb`, `uptime_s`). It is public, so counts only,
never identities. `serve` logs the same set as a heartbeat every 15 min (`STATS_INTERVAL_MS`,
shouting past `HEAP_WARN_PCT`), plus one line per request slower than `SLOW_REQUEST_MS` (SSE
streams excluded, they are long-lived by design). Counts that never fall back to zero while nobody
is connected, or a heap share that only climbs, name a leak from the log alone.

### `/health` returns 503 on sustained heap pressure, judged on the post-GC floor

An orchestrator can only recycle a wedged-but-alive process if the process says it is unwell;
probe latency can't tell "GC spiral" from "small host under load". V8 routinely fills the heap to
~90% just before a major GC, so an instantaneous reading is meaningless. The detector keeps the
last `HEAP_WINDOW_SAMPLES` readings and tests their MINIMUM (the floor collection actually
recovers to) against `HEAP_CRITICAL_PCT`. Samples come from `/health` calls themselves, spaced by
`HEAP_SAMPLE_MIN_GAP_MS` so a burst of probes cannot fill the window, and a partial window yields
no verdict, so a freshly booted process is never reported unhealthy. These constants live in
`src/serve.ts`.

Deployments should bound this process twice, in this order: cap the heap in-process
(`--max-old-space-size`) so a runaway crashes and restarts long before it can starve its host,
and set any container memory limit above that ceiling, not below it. Below, and the supervisor
kills the process mid-write instead of letting V8 hit its own clean heap OOM. The in-process cap
is also the only one that always works: a container limit silently does nothing on a host whose
kernel ships without the memory cgroup controller.

## Gateways and the app proxy

### Gateway passthrough is verbatim and protocol-level (pinned SDK internals)

Upstream tools must reach Claude with their exact JSON schemas and annotations, because a curated
upstream's per-endpoint guidance is its value. Tool names get a mandatory per-server prefix
(derived from the gateway name, unique per user) and descriptions/titles a "Server: "
attribution, so every tool stays traceable to its server in tool lists and permission UIs.

The SDK's `registerTool` is zod-only and would re-serialize schemas, so `attachGatewayTools`
wraps the underlying `Server`'s stored `tools/list` and `tools/call` handlers (private
`_requestHandlers` / `_registeredTools`, read through `sdkInternals()` in `src/gateways.ts`; a
test in `tests/serve.test.ts` fails loudly when an SDK upgrade moves them).

Gateway URLs are SSRF-guarded: https-only, no private/internal targets, re-checked per request and
per redirect hop. `GATEWAY_ALLOW_INSECURE=1` relaxes this for 127.0.0.1 mock upstreams in tests
only. Upstream credentials (OAuth tokens, DCR client info, static bearer) live in the sealed
per-user secret store; a failed upstream is skipped for the session and surfaced on the account
page, never breaking coaching.

### Gateway tool lists are cached; gateway connections never are

Connecting to every upstream and paging through `tools/list` on every session, synchronously
ahead of the session being usable, measured at ~4 s of a live deployment's own `initialize`, paid
again per concurrent session, for data that changes when an upstream ships a release. So
`mountUserGateways` serves tools from a per-gateway cache (`GATEWAY_TOOLS_TTL_MS`, 12 h) and
`MountedGateway.getClient` defers the socket until a `tools/call` actually routes upstream. A
session that never invokes an upstream tool never opens one. The split is the correctness
argument: a stale tool _list_ costs at worst a confusing description until the TTL lapses,
whereas a stale _connection_ would break calls.

Invalidate (`invalidateGatewayTools`) on anything that changes what an upstream exposes: the
account page's Connect refreshes it, `deleteGateway` drops it. The escape hatch is the
`refresh_connected_servers` tool, registered per session only when gateways mounted. It re-mounts
with `force` and swaps the exposed set via the `rebuild` returned by `attachGatewayTools` (the SDK
cannot re-register handlers mid-session, so the tool list behind them is mutable by design). It
must call `sendToolListChanged()`; without that notification the client keeps serving its cached
`tools/list` and the refresh is invisible.

### App proxy authorization is allowlist-per-app

A login alone never exposes a protected app; the user's email must be on that app's own list
(`PROTECTED_APP_<NAME>_EMAILS`).

### App proxy prefix rewriting stays idempotent

The proxy moves root-absolute URLs in HTML bodies and `Location` headers onto `/apps/<name>` for
apps that only emit `href="/…"`. It also sends `X-Forwarded-Prefix`, so a well-behaved app
prefixes its own URLs, and rewriting those again yields `/apps/x/apps/x/…` and breaks every link
and redirect on the page. `isUnderPrefix` does the boundary-checked skip (`/apps` must not swallow
`/appstore`); route any new prefixing through `withPrefix`/`rewriteHtmlPrefix` rather than
concatenating.

## Operational CLIs

### Snapshot, restore and the clobber guard

`coaching-mcp-snapshot` writes `seed-manifest.json` (raw SQLite `datetime('now')` strings,
fixed-width UTC, so string compare = chronological); the `.md` files stay byte-identical to DB
`content`. `coaching-mcp-restore` upserts `sections`/`refs` from a seed dir into a live DB and
preserves `journal`, `open_items` and routines. It treats content changes where live `updated_at`
is newer than the manifest as conflicts: abort-all unless `--force`; `--dry-run` reports
`STALE SEED` but exits 0. No manifest → legacy mode (guard off, warns).

### `coaching-mcp-backup-db` covers the DBs snapshot doesn't

`coaching-mcp-backup-db <src> <dest>` makes a consistent, WAL-safe copy of an arbitrary SQLite
file via SQLite's online backup API. Use it for opaque operational DBs the schema-aware snapshot
doesn't cover, notably auth.db (identity → user-id map + sealed per-user secrets), which must be
backed up alongside per-user snapshots or a restore can't reconstruct users.
