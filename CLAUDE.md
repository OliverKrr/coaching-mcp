# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Standalone package — keep it self-contained.** This repo must not reference any specific
> deployment or sibling repo: no hostnames, no domains, no other repo names or paths, no external
> `just`/CI recipes, no "the Raspberry Pi". That includes source, CLI output, tests, and this
> CLAUDE.md. Describe behaviour in terms of this package's own tools/CLIs and use only **generic
> examples**. Deployment-specific wiring belongs in the deployment repo, never here.

## What this repo is

Coaching MCP server for Claude AI. Serves a `SKILL.md` knowledge base (goals, rules, athlete profile) plus reference documents and a session journal, all stored in SQLite+FTS5 and exposed as MCP tools. It runs as a Docker container reading its DB from a persistent volume; for remote MCP access it is typically fronted by an OAuth 2.0 proxy (configured by whatever deployment consumes this package).

## Commands

Use `just` for everything (see `Justfile` for the full list):

```sh
just build        # compile TypeScript (tsdown → dist/index.js)
just test         # vitest run
just check        # oxlint + oxfmt --check
just fix          # oxlint + oxfmt --write (auto-format)
just types        # tsc --noEmit
just dev          # tsx src/index.ts (stdio, no supergateway)
just update-deps  # ncu -u && npm install
```

Direct npm equivalents if just is not installed:

```sh
npm run build
npm test
npm run check
npm run check:fix
npm run check:types
```

## Architecture

```
coaching-mcp (Node 26 binary)
  └── src/db.ts           SQLite+FTS5 database: sections, refs, journal tables
  └── src/tools/read.ts   4 read tools (get_coaching_context, search_knowledge, get_reference, get_journal)
  └── src/tools/write.ts  3 write tools (update_section, update_reference, append_journal)
  └── src/utils/errors.ts toolText() / toolError() / withErrorHandling() helpers
  └── src/index.ts        McpServer → StdioServerTransport → supergateway (port 8000)
```

Seed data flow (first start only):

```
/seed/SKILL.md            → sections table (name='main')
/seed/references/*.md     → refs table (name = filename without .md)
```

After first seed, all writes go through the MCP tools. The `/seed` volume is read-only.

`coaching-mcp-restore` (inverse of `coaching-mcp-snapshot`) upserts `sections`/`refs` from a seed dir into a live DB, so edited seed files reach an already-seeded DB; it preserves `journal` + `open_items`. It overwrites section/ref content from files — snapshot first if the live DB may have diverged. **Safe by default:** pass `--dry-run` to open the DB read-only and preview the exact `created`/`changed`/`unchanged`/`conflicts` plan without writing anything (no transaction, no upsert, no `updated_at` bump). Consuming tooling can split this into a preview step and a write step so an everyday command can't clobber live edits.

**Clobber guard (v1.3.0):** `coaching-mcp-snapshot` writes a `seed-manifest.json` at the seed root recording each doc's `updated_at` (raw SQLite `datetime('now')` strings — fixed-width UTC, so string compare = chronological). The `.md` files stay byte-identical to DB `content` (restore's `unchanged` detection depends on that), so the timestamp lives in the sidecar, not per-file frontmatter. When a manifest is present, `coaching-mcp-restore` treats a content change as a **conflict** if the live `updated_at` is newer than the manifest's timestamp for that doc (or the manifest has no entry for it) — i.e. the seed is stale and would overwrite newer live content. A conflict **aborts the whole write** (exit 1, nothing written) unless `--force` is passed; `--dry-run` reports conflicts as `STALE SEED` warnings but still exits 0, so the preview doubles as a stale-seed drift detector. No manifest → legacy mode (guard off, warns). `created` docs (absent from live) always apply. The guard needs no DB schema change — `updated_at` already exists on `sections`/`refs`; only `updated_by` is intentionally not tracked (single-user system).

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

## Environment variables (runtime)

| Variable   | Default | Description                                  |
| ---------- | ------- | -------------------------------------------- |
| `DATA_DIR` | `/data` | SQLite database location (persistent volume) |
| `SEED_DIR` | `/seed` | Seed markdown files (read-only volume)       |

## Key design decisions

**FTS5 external content tables**: `sections_fts`, `refs_fts`, `journal_fts` are external-content virtual tables. All three require INSERT + UPDATE + DELETE triggers to stay in sync with their base tables. Do not remove any trigger from `db.ts`.

**Seed idempotency**: `seedFromDirectory()` checks `COUNT(*) FROM sections` before seeding — safe to call on every start. Wrapped in a `db.transaction()` to prevent partial state if the process is killed mid-seed.

**tsdown + fixedExtension**: `tsdown.config.ts` sets `fixedExtension: false` so output is `dist/index.js` (not `.mjs`), matching the `bin` entry in `package.json`.

**Prepared statements**: All SQL statements used in loops are hoisted outside the loop — `db.prepare()` is called once, not per iteration.
