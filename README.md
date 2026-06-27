# coaching-mcp

Personal coaching MCP server for Claude AI, backed by SQLite + FTS5. Serves a `SKILL.md` coaching knowledge base with full-text search, reference documents, and a session journal — accessible from Claude web, desktop, and Android via remote MCP.

## Tools

| Tool                   | Description                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| `get_coaching_context` | Returns the full `SKILL.md` content                                            |
| `search_knowledge`     | FTS5 full-text search across sections, references, and journal                 |
| `get_reference`        | Returns a reference document by name                                           |
| `get_journal`          | Returns recent journal entries newest-first                                    |
| `update_section`       | Upserts a knowledge section                                                    |
| `update_reference`     | Upserts a reference document                                                   |
| `append_journal`       | Appends a coaching journal entry                                               |
| `add_open_item`        | Records a commitment (if-then next action) or a de-duplicated flag             |
| `list_open_items`      | Lists open commitments/flags (defaults to status=open) — call at session start |
| `resolve_open_item`    | Closes an open item (done/dismissed) with an optional note                     |

## Quick start (Docker Compose)

```yaml
services:
  coaching_mcp:
    build: . # or: image: ghcr.io/oliverkrr/coaching-mcp:main
    volumes:
      - coaching_data:/data
      - ./my-coaching-data:/seed:ro

volumes:
  coaching_data:
```

## Seed directory layout

```
seed/
├── SKILL.md          # Required — primary coaching context, loaded as section 'main'
└── references/       # Optional — one file per topic
    ├── zones.md
    ├── strength.md
    └── workout-construction.md
```

The database is seeded only on first start (when `sections` is empty). After that, all writes go through the MCP tools — the seed mount is only read on init.

## Environment variables

| Variable   | Default | Description                                                 |
| ---------- | ------- | ----------------------------------------------------------- |
| `DATA_DIR` | `/data` | Where `skill.db` is stored (mount a persistent volume here) |
| `SEED_DIR` | `/seed` | Where seed markdown files are mounted (read-only)           |

## Snapshot & recovery

`coaching-mcp-snapshot` dumps the SQLite database to a local directory — a lossless,
WAL-safe binary copy for recovery plus human-readable markdown for inspection. It operates
on a **local DB file path**; how you reach the file (locally, `docker exec`, etc.) is up to
your deployment.

```sh
just snapshot                 # → ./snapshots (gitignored)
just snapshot /path/to/out    # custom output dir
# or directly:
node dist/snapshot-cli.js ./snapshots --db /data/skill.db
```

Output (full mode):

| File                   | What                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `skill.db`             | Lossless online backup — the recovery artifact (FTS, triggers, timestamps, journal). |
| `SKILL.md`             | The `main` knowledge section.                                                        |
| `sections/<name>.md`   | Other sections.                                                                      |
| `references/<name>.md` | Reference documents.                                                                 |
| `journal.md`           | All journal entries, newest first, with timestamps (inspection only).                |

`--seed-only` emits just `SKILL.md` + `references/*.md` (the files the seed loader reads).

### Apply / restore (files → DB)

`coaching-mcp-restore` is the inverse of snapshot: it upserts the `sections` and `refs` tables
from a seed directory into a **live** DB. This is how edited seed files (`SKILL.md`,
`sections/*.md`, `references/*.md`) reach a DB that has already been seeded — `seedFromDirectory()`
only loads when the DB is empty, so editing seed files alone never updates a running DB.

```sh
just restore                          # apply ./seed (or wherever) → DB
node dist/restore-cli.js /seed --db /data/skill.db
```

It reads each seed file, compares it to the existing row, and upserts only when the content
actually differs (so `updated_at` is bumped only on real changes and the FTS index stays in
sync via triggers). The `journal` and `open_items` tables are never touched, so live coaching
history is preserved.

> **Safety:** restore overwrites section/ref content from files. If the live DB may have diverged
> from your seed files (e.g. sections edited via the MCP tools since the last sync), run a snapshot
> first (`just snapshot`) and review the diff before applying.

**Recovery** (any deployment):

1. Stop the server/container.
2. Replace `${DATA_DIR}/skill.db` with the backed-up `skill.db`; delete any `skill.db-wal` /
   `skill.db-shm` sidecars.
3. Start the server. The index, triggers, timestamps, and journal are all intact — the
   artifact is a byte-consistent copy.

### Example: remote Docker deployment

If the server runs in a container on another host, run the tool inside the container (it
ships in the image) and copy the result out — e.g. driven by an orchestrator such as
Ansible:

```sh
# Stage a consistent snapshot inside the container, then stream it out
docker exec <container> coaching-mcp-snapshot /data/backup --db /data/skill.db
docker cp <container>:/data/backup - | tar -xf - -C ./snapshots --strip-components=1
```

Adapt `<container>`, the host, and transport to your environment.

## License

MIT
