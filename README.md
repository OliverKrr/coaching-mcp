# skill-mcp

Serve any Claude `.skill` file as a remote MCP server backed by SQLite + FTS5.

## What it does

`skill-mcp` reads a `SKILL.md` and optional `references/*.md` from a seed directory
on startup, stores them in a local SQLite database, and exposes 7 MCP tools for AI
assistants to read and update coaching (or any other) context over a persistent connection.

## Tools

| Tool | Description |
|------|-------------|
| `get_coaching_context` | Returns the full `SKILL.md` content |
| `search_knowledge` | FTS5 full-text search across sections, references, and journal |
| `get_reference` | Returns a reference document by name |
| `get_journal` | Returns recent journal entries newest-first |
| `update_section` | Upserts a knowledge section |
| `update_reference` | Upserts a reference document |
| `append_journal` | Appends a journal entry |

## Quick start (Docker Compose)

```yaml
services:
  skill_mcp:
    build: .   # or: image: ghcr.io/your-username/skill-mcp:latest
    volumes:
      - skill_data:/data
      - ./my-skill/data:/seed:ro

volumes:
  skill_data:
```

## Seed directory layout

```
seed/
├── SKILL.md          # Required — primary context, loaded as section 'main'
└── references/       # Optional — one file per reference topic
    ├── zones.md
    └── strength.md
```

The database is seeded only on first start (when `sections` is empty).
After that, all writes go through the MCP tools — the seed mount is only read on init.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `/data` | Where `skill.db` is stored (mount a persistent volume here) |
| `SEED_DIR` | `/seed` | Where seed markdown files are mounted (read-only) |

## Adding a second skill (same Pi, different path)

1. Create `<name>-skill/data/SKILL.md` + optional `references/*.md`
2. Add `<name>_mcp` and `<name>_oauth_proxy` services to `docker-compose.yml`
3. Add `location /<name>/` block to nginx pointing to `<name>_oauth_proxy`

No code changes needed — the same image handles any skill.

## License

MIT
