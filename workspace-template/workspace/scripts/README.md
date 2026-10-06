# scripts/

Analysis scripts (run with `uv run scripts/<name>.py`) and the routine runner.

## Routines

`run_routine.sh <name> [extra context]` runs one routine as a headless `claude -p` turn from `$HOME`,
with this repo added through `--add-dir`. It takes the prompt from `routines/<name>.md` when that
file exists, and otherwise runs the routine `<name>` stored on the coaching server (`list_routines`
shows them). Each run appends to `data/routines.log`.

- **Tool grants.** A headless run silently denies every tool not granted. The runner always grants
  the coaching server (`COACHING_SERVER` in `routines/config.env`); `routines/<name>.tools` adds
  more, space separated (`Bash Read Write Edit Grep Glob`, `WebSearch`, another MCP server).
- **Verdict.** The run must end on a `DELIVERED`, `SILENT` or `FAILED` line. Anything else is a
  failure, logged and pinged to healthchecks as `/fail`.
- **Delivery.** A routine reaches the user through `notify_user` (present when the user linked
  Telegram on the coaching server) or, failing that, a journal entry the next session sees.
- **Watchdog.** Optional: one healthchecks.io check per routine, its ping URL in `healthchecks.env`
  as `<name>=<url>`. A dead machine stops every routine silently; this is how you notice.
- **Scheduling.** One crontab line per routine, e.g.
  `45 7 * * * /path/to/workspace/scripts/run_routine.sh readiness`. cron uses the system timezone
  (Debian's cron ignores `CRON_TZ`), so keep that set to the user's.
- **Login.** All runs share the interactive claude.ai login, so the runner spaces starts at least
  20 s apart (needs `flock`). When the login dies, every run fails within seconds with an auth
  error in the log; the fix is an interactive `claude` then `/login`.

Test a routine by running it by hand and reading the last lines of `data/routines.log`.
