# Coaching workspace

A Claude Code workspace for coaching analyses. The coaching knowledge lives in the coaching MCP
server; this repo holds analysis scripts, scheduled-routine runners and throwaway exports.
`CLAUDE.md` is the operating manual for the sessions that work here.

```sh
uv sync                                  # analysis toolchain (pandas, matplotlib)
uv run scripts/<name>.py                 # run an analysis
scripts/run_routine.sh <routine-name>    # run a scheduled routine once, headless
```

Layout: `scripts/` analysis code and the routine runner · `scripts/routines/` local routine
prompts and tool grants · `TODO.md` work handed between sessions · `handoff/` open defects ·
`data/`, `out/` gitignored exports and charts.
