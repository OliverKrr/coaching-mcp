# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Personal coaching MCP server for Claude AI. Serves a `SKILL.md` knowledge base (goals, rules, athlete profile) plus reference documents and a session journal, all stored in SQLite+FTS5 and exposed as 7 MCP tools. Runs as the `coaching_mcp` Docker container on the Raspberry Pi, reachable at `mcp.ponyfreude.de/coaching/` via `coaching_oauth_proxy`.

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
coaching-mcp (Node 24 binary)
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

## MCP tools

| Tool                   | Direction | Description |
|------------------------|-----------|-------------|
| `get_coaching_context` | read      | Full SKILL.md — call at session start |
| `search_knowledge`     | read      | FTS5 full-text search across all tables |
| `get_reference`        | read      | One reference doc by name |
| `get_journal`          | read      | Recent journal entries, newest first |
| `update_section`       | write     | Upsert a knowledge section (use `main` for SKILL.md) |
| `update_reference`     | write     | Upsert a reference doc |
| `append_journal`       | write     | Append a coaching journal entry |

## Environment variables (runtime)

| Variable   | Default | Description |
|------------|---------|-------------|
| `DATA_DIR` | `/data` | SQLite database location (persistent volume) |
| `SEED_DIR` | `/seed` | Seed markdown files (read-only volume) |

## Key design decisions

**FTS5 external content tables**: `sections_fts`, `refs_fts`, `journal_fts` are external-content virtual tables. All three require INSERT + UPDATE + DELETE triggers to stay in sync with their base tables. Do not remove any trigger from `db.ts`.

**Seed idempotency**: `seedFromDirectory()` checks `COUNT(*) FROM sections` before seeding — safe to call on every start. Wrapped in a `db.transaction()` to prevent partial state if the process is killed mid-seed.

**tsdown + fixedExtension**: `tsdown.config.ts` sets `fixedExtension: false` so output is `dist/index.js` (not `.mjs`), matching the `bin` entry in `package.json`.

**Prepared statements**: All SQL statements used in loops are hoisted outside the loop — `db.prepare()` is called once, not per iteration.
