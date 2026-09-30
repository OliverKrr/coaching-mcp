---
paths:
  - "src/db.ts"
  - "src/history.ts"
  - "src/quota.ts"
---

# Schema and triggers

- Keep every trigger in `src/db.ts`. The FTS sync (`*_fts`), quota (`*_bytes_*`) and
  delete-capture (`*_hist_ad`) families are the only thing keeping search, `content_bytes` and
  change history correct, and no application code path backs them up.
- Add tables and triggers with `CREATE ... IF NOT EXISTS` in `createSchema()`. It runs on every
  open, so existing per-user DBs pick them up with no migration step.
- Add a column by probing `pragma table_info` before `ALTER TABLE ADD COLUMN`, since SQLite has no
  `ADD COLUMN IF NOT EXISTS`. The new column lands at the end of the column list.
- To change what the journal indexes, edit the shared `JOURNAL_INDEX_SQL` string and extend the
  probe in `migrateJournalIndex`. An FTS5 table cannot gain a column and a trigger body cannot be
  altered, so the family is dropped, recreated and `rebuild`t from the base table once.
- Keep change-history rows out of `content_bytes`; they are bounded by `pruneChanges` on open
  instead, so the safety net never eats a user's quota.
- `metrics` stays outside FTS and outside change history (structured measurement log, not prose).

Full rationale: `docs/design-decisions.md`, section "Storage and schema".
