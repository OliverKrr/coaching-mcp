# coaching-mcp

Personal coaching MCP server for Claude AI, backed by SQLite + FTS5. Serves a `SKILL.md` coaching knowledge base with full-text search, reference documents, and a session journal — accessible from Claude web, desktop, and Android via remote MCP.

## Tools

| Tool                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `get_coaching_context` | Returns the full `SKILL.md` content                            |
| `search_knowledge`     | FTS5 full-text search across sections, references, and journal |
| `get_reference`        | Returns a reference document by name                           |
| `get_journal`          | Returns recent journal entries newest-first                    |
| `update_section`       | Upserts a knowledge section                                    |
| `update_reference`     | Upserts a reference document                                   |
| `append_journal`       | Appends a coaching journal entry                               |

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

## License

MIT
