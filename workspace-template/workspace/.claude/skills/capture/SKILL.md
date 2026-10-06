---
name: capture
description: Captures a durable finding from this session into the right store. In this workspace the knowledge base IS the coaching MCP server - user facts, decisions and analysis findings route to its tools (record_metric, append_journal, add_open_item, edit_reference, edit_section), never into markdown files here; only repo-technical gotchas land in this repo's CLAUDE.md. Use at session close, before compaction, or whenever something worth keeping surfaced.
---

# Capture — one brain, not two

This repo has no knowledge base of its own. The coaching MCP server is the single one: it is
searchable, loaded into every session via `start_session`, covered by change history, and shared by
every client (claude.ai chat and these Code sessions). A markdown finding here would be invisible to
the chat sessions that need it. Route each capture to one destination:

| What was learned                                                 | Destination                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A number about the user (weight, threshold, baseline, adherence) | `record_metric`. `state` series supersede (thresholds, baselines), `event` series accumulate (volumes, counts) |
| What happened, was decided, or was found in an analysis          | `append_journal`: headline first line, then Decided / Learned / Committed / Watch for                          |
| A commitment or something to watch                               | `add_open_item` (kind commitment/flag, `relevant_date` when dated)                                             |
| A durable method, pattern or rule about coaching this user       | `edit_reference` / `edit_section`. The coaching context's document tiers say which need the user's OK first    |
| Reusable analysis code                                           | Commit it under `scripts/` and record it in the coaching reference that lists analysis scripts                 |
| A repo-technical gotcha (toolchain, library quirk, API surprise) | The **Gotchas** section of this repo's `CLAUDE.md`: one bullet naming the mechanism, then commit               |

## Procedure

1. State the finding in one sentence. One that cannot be stated that way is not a finding yet.
2. Pick one destination. When two fit, the coaching server wins over the repo, and the more
   structured tool wins over the journal (a number is a metric, not prose).
3. Look for an existing home first: `search_knowledge`, `get_metrics` for the series, or the
   Gotchas. Update or supersede it rather than adding a duplicate.
4. Write it, following the coaching context's format and language rules.
5. Keep secrets, keys and other people's data out of every destination.
