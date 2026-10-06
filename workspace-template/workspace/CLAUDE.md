# CLAUDE.md — coaching workspace

The analysis workbench for the user's coaching. Claude Code sessions arrive here interactively, over
Remote Control from a phone, or headless from cron, and they own this repo end to end.

## The coaching server is the source of truth

Coaching knowledge (goals, zones, patterns, history, open items, the journal) lives in the coaching
MCP server and loads per session. This repo stores no coaching state and overrides nothing there. A
fact that belongs in the user's record goes back through the server's write tools (`update_section`,
`edit_section`, `update_reference`, `edit_reference`, `append_journal`, `record_metric`), because chat
sessions on claude.ai read the server and never this repo.

This repo is for analyses that need real compute (pandas, matplotlib, model fits), the scripts that
run them, and throwaway data exports.

## Session start

Work that touches no coaching data (repo, tooling, git, routine plumbing) may skip `start_session`.
As soon as a turn touches training, planning, user facts, or a write to the coaching database, it
counts as coaching; treat an unclear case as coaching. For coaching:

1. Call `start_session` first and follow the operating procedure it returns. Read `TODO.md` (work
   handed on by earlier sessions) and `handoff/README.md` (open infrastructure defects).
2. Work the open items before coaching, overdue ones first.
3. Anchor the date on a tool that reports the user's local date (for training, the data platform's
   athlete profile) rather than the system clock, and name every day of a plan with its date.
4. Answer coaching questions from the loaded record, never from memory. If the coaching server is
   unreachable, say so and stop coaching.

## Git: commit and push, no human in the loop

- Commit after every coherent unit of work.
- Push after each commit (`git pull --rebase` first). Work that is not pushed does not exist once
  the machine dies, so pushing is your job here.
- Stage explicit paths. Other sessions and routines share this checkout, so never `git add -A`,
  and never stash, reset or check out files you did not change.
- Never force-push, rewrite history or skip hooks.

## Getting data in: the heredoc rule

Tool results reach disk verbatim:

```sh
cat > data/activities.csv <<'EOF'
<paste the tool result exactly as returned>
EOF
```

Hand-transcribed values are the main source of silent errors. Every number shown to the user — in a
reply, a chart label, a stat tile — is computed by a script and copied from its stdout.

## Scripts

`scripts/` holds the analysis code; run it with `uv run scripts/<name>.py`.

1. Check `scripts/` before writing an analysis from scratch.
2. Keep scripts parameterized. Thresholds and baselines are coaching decisions that live in the
   user's documents; a rule buried in a script is invisible to everyone else.
3. A result a chat session must see goes into the journal or metrics through the server tools.
   Chat sessions read outcomes, not code.
4. When you add, change or delete a reusable script, record it (trigger, call, verified case) in the
   coaching reference that lists analysis scripts, so other sessions find it.

Charts go to `out/` as PNGs. Read the PNG back before delivering it; overlapping labels and empty
panels are visible to you.

## Skills

`capture` (in `.claude/skills/`) routes a durable finding to the right coaching-server tool, or a
repo-technical gotcha into the Gotchas below. Use it when a session produced one, and when the
PreCompact hook reminds you before compaction.

## Keep the session-start path short

`CLAUDE.md`, `TODO.md` and `handoff/README.md` load before any work, so every stale line costs every
session. Finishing a piece of work removes what it made obsolete in the same commit: a fixed defect
loses its `handoff/` file and index row, a finished `TODO.md` item loses its entry. `git log` is the
history.

## Routines

Scheduled check-ins run as headless `claude -p` turns through `scripts/run_routine.sh <name>`, started
by cron. Read `scripts/README.md` before editing the runner, a routine prompt or a `.tools` file.

## Replies

- Reply in the language the user writes in.
- Name content, not item or journal numbers.
- Be decisive on data and safety, collaborative on direction, and give the reason.

## Credentials and limits

- `.env` holds API keys (mode 0600). Keys stay out of commits, transcripts, charts and replies.
- Stop and ask the user before anything that writes to an external platform (pushing or deleting
  workouts, routines, calendar entries), before changing a coaching document whose tier says to ask
  first, and before anything that needs a credential you do not have. If the user is not there,
  leave the work in `TODO.md`.

## Finishing a session

A session is done when its work is committed (and pushed, with a remote), and `TODO.md` and `handoff/` reflect what
is still open.

## Gotchas (repo-technical)

Maintained by `capture`: one tight bullet per mechanism, newest last.

- A headless `claude -p` silently denies any tool missing from `--allowedTools`; the run continues
  and does less. A server-level grant (`mcp__<server>`) covers all of that server's tools.
- Shell state does not persist between tool calls: export `PATH` in the same command that needs it.
