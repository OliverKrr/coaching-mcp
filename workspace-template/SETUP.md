# Set up a Claude Code coaching workspace

You are Claude Code, on the user's own machine, and the user asked you to set up a coaching
workspace there. This guide comes from their coaching MCP server (version {{VERSION}}). Work through
it with the user, step by step, and adapt it to what you find; it describes the target, not a script
to paste.

**What the user ends up with.** A git repo (the _workspace_) where Claude Code sessions do coaching
analyses with real compute (pandas, charts), while every coaching fact stays in the coaching server.
Optionally, on a machine that stays on: Remote Control, so the Claude app on their phone opens
sessions in the workspace, and scheduled routines that run headless from cron.

**Rules for this setup.**

- Ask before anything outside the workspace directory: `sudo`, systemd, crontab, `~/.gitconfig`,
  files in `~/.claude` or `/etc`. Show the exact command or file first. When you cannot run a step (no sudo, an
  interactive prompt), hand the user the command and wait.
- Never print, commit or echo secrets: API keys, tokens, `~/.claude/.credentials.json`, `.env`.
- Do not write to the coaching server during setup, except where a step below says so.
- Write template files exactly as given. Change only the placeholders a step names.
- Claude Code protects `.claude/` directories and `~/.claude/settings.json`: writing there asks for
  approval even when other edits are allowed, and is refused outright when nobody can answer (an
  unattended run), whatever the user approved beforehand. Do not work around a refusal; hand the
  user the exact content or command and list it in the hand-over.

## 1. Check the preconditions

Check each one and report the result to the user in one short list before you go on.

1. **The coaching server is reachable from Claude Code.** Find this server among your MCP tools: a
   tool named `mcp__<server>__start_session`. `mcp__<server>` is the _server grant_ used below (a
   claude.ai connector named "Coaching" appears as `mcp__claude_ai_Coaching`). Call
   `start_session` with scope `items` once to prove the connection works. If no such tool exists,
   stop: the user connects the server first, either as a connector in their claude.ai account (and
   Claude Code logged in with that account) or with `claude mcp add --scope user` (the default scope ties the server to one directory, and
   routines run from `$HOME`). A healthy reply is the open-items list; a `[hub]` budget line at its
   top is normal. If more than one server offers `start_session` (a claude.ai connector and a
   directly added server, say), ask the user which one holds their coaching, and use that grant
   everywhere below.
2. **Login type.** Remote Control and claude.ai connectors in headless runs need Claude Code logged
   in with a claude.ai account, not an API key. Ask the user if unsure.
3. **Tools.** `git` is required. `uv` is needed for the analysis toolchain
   (`curl -LsSf https://astral.sh/uv/install.sh | sh` installs it per user). Note the OS and
   whether the machine stays on (a server, a Raspberry Pi, a home box) or sleeps (a laptop).

## 2. Agree on the shape with the user

Ask these together, offer the default, and continue with the defaults if the user has no
preference:

1. Workspace path. Default `~/coach-workspace`.
2. A private git remote for the workspace? Recommended: the machine is the least durable part of
   the setup. The user creates an empty **private** repo; on a headless machine, a deploy key with
   write access scoped to that one repo is safer than a personal token.
3. Remote Control from the phone? Only useful on a machine that stays on.
4. Scheduled routines? Also only on a machine that stays on. `list_routines` shows what the user
   has stored on the server.
5. A dedicated user account? On a machine others use, or that holds other services' data, run the
   workspace as an unprivileged user with no sudo and no docker group: sessions then cannot read
   anything that user cannot. On a personal machine the user's own account is fine. With a
   dedicated user, the user creates it (`sudo adduser`), and every later step runs as that user in
   a terminal of theirs: the `uv` install, `claude` and `/login`, its `~/.claude/settings.json`, its
   git identity and its crontab. Your session is then the guide, and the user types the commands.

## 3. Create the workspace

The template files are in the appendix at the end of this guide. Paths there are relative to the
workspace root. Files under `host/` are not part of the workspace: write them only in step 5 or 6,
when the user chose that, to the place the step names.

1. Create the workspace directory and write every file under `workspace/` into it, without the
   `workspace/` prefix. Write `workspace/gitignore` as `.gitignore`. Make
   `scripts/run_routine.sh` executable. Claude Code asks for approval before writing into `.claude/`,
   even when other edits are allowed; tell the user that two prompts for it are expected.
2. In `scripts/routines/config.env`, set `COACHING_SERVER` to the server grant from step 1.1 and
   `CLAUDE_BIN` to the absolute path of `claude` (`command -v claude`), because cron's `PATH` is
   minimal.
3. With `uv`: run `uv sync` in the workspace and confirm
   `uv run python -c "import pandas, matplotlib"` succeeds. On a small ARM board this can take
   minutes; say so before starting. `uv.lock` is committed with the rest.
4. `git init -b main`, then commit everything as the first commit. With a remote: add it and push.
   Without one, delete the "Git" section's push rules from the workspace `CLAUDE.md` (keep the
   commit rules) so sessions do not try to push. A bare repo the user created by hand
   (`git init --bare`) may point its `HEAD` at `master`; set it to `main`
   (`git --git-dir=<remote> symbolic-ref HEAD refs/heads/main`) so later clones check out the
   branch. Hosted remotes (GitHub and the like) take the first pushed branch on their own. A fresh account has no git identity, and every commit (the autosave's too) then fails: if
   `git config --global user.email` is empty, ask the user for a name and email (a noreply
   address is fine) and set both globally for the workspace user.
5. Optional `.env`: copy `.env.example` to `.env` with mode 0600 only if the user wants scripts to
   call a data platform's API directly. The user types the key into the file themselves.

## 4. Raise the MCP output cap

`start_session` returns the whole coaching context in one call, and a mature record exceeds Claude
Code's default MCP output limit; the call then comes back as an error plus a dump file. Merge this
into the user's `~/.claude/settings.json` (create the file if missing, keep every existing key), so
interactive sessions, Remote Control and routines all get it:

```json
{ "env": { "MAX_MCP_OUTPUT_TOKENS": "40000" } }
```

Ask before writing. It takes effect in new sessions. If the user declines or is not there, list
it in the hand-over: a small record works without it, and the first symptom of a grown one is
`start_session` returning an error and a dump file.

## 5. Remote Control (machine that stays on)

Skip this step unless the user chose Remote Control.

1. **One-time interactive login and consent.** The user does this in a terminal on the machine, as
   the workspace user; you cannot answer these prompts for them. Hand them the steps:
   - `cd <workspace> && claude`, then `/login` if not logged in, accept the workspace trust dialog,
     `/exit`. Trust is per directory and the workspace must exist first (step 3): trust accepted
     anywhere else, even in `$HOME`, does not count, and the service then restarts in a loop with
     "Workspace not trusted" in its journal while `systemctl` shows only `activating`.
   - `claude remote-control --name <device name> --spawn same-dir`, answer the "Enable Remote
     Control?" prompt with `y`, wait for "Connected", then Ctrl+C.
2. **Keep it running.**
   - Linux with systemd: fill the placeholders in `host/claude-remote-control.service` and show the
     user the result and the install commands:
     `sudo cp claude-remote-control.service /etc/systemd/system/`,
     `sudo systemctl daemon-reload`, `sudo systemctl enable --now claude-remote-control`.
     Verify with `systemctl is-active claude-remote-control` (`active`, not `activating`) and
     `journalctl -u claude-remote-control -n 20`.
   - macOS: offer a LaunchAgent in `~/Library/LaunchAgents/` that runs the same command with
     `KeepAlive` and `WorkingDirectory` set to the workspace, and remind the user that a sleeping
     Mac drops the connection.
3. Ask the user to open the Claude app: the device appears under its name, and a session started
   there opens in the workspace.

## 6. Routines (machine that stays on)

Skip this step unless the user chose routines. Read the workspace's `scripts/README.md` first.

1. With the user, pick the routines to run here (`list_routines`) and a time for each, in their
   timezone. A routine that already runs as a Claude scheduled task elsewhere would then run twice:
   ask the user to pause one.
2. macOS has neither `flock` nor `timeout`, and without them the runner cannot space starts
   (which protects the shared login) or kill a hung run. Offer `brew install flock coreutils`
   (the runner also finds `gtimeout`).
3. Run one routine by hand: `scripts/run_routine.sh <name>`, then read the tail of
   `data/routines.log`. It must end on a `DELIVERED`, `SILENT` or `FAILED` line. A run that fails
   within seconds with an authentication error means the claude.ai login is missing or expired.
   This is a real run: it may write a journal entry or message the user. Say so, and pick the
   routine with the user, before you start it.
   If the routine needs more than the coaching server (a shell, file writes, web search), list
   those tools in `scripts/routines/<name>.tools`; a headless run silently denies everything not
   granted.
4. Install the crontab from `host/crontab.example` with the user's routines and paths. cron runs
   in the system timezone (`timedatectl` shows it), and Debian's and Raspberry Pi OS's cron ignore
   `CRON_TZ`. If the system timezone is not the user's, ask before setting it
   (`sudo timedatectl set-timezone <Area/City>`); otherwise convert the times, and note that a
   fixed UTC time drifts by an hour at each daylight-saving change.
   With a git remote, also install `host/autosave.sh` (outside the repo, e.g. `~/bin/`) and its
   cron line. Show the final crontab and ask before running `crontab`.
5. Optional watchdog: a healthchecks.io check per routine, its ping URL in the workspace's
   `healthchecks.env` as `<name>=<url>`. The user creates the checks in their healthchecks.io
   account.

## 7. Verify

Do each check yourself and report pass or fail with the evidence:

1. A fresh headless turn from `$HOME`, the path routines take, reaches the server:
   `cd ~ && claude -p "Call start_session with scope items and reply with only the number of open items." --allowedTools <server grant>`.
2. The workspace is committed (`git status` clean) and, with a remote, pushed.
3. Remote Control: the unit is active, and the user confirms the device shows in the Claude app.
4. Routines: one hand-run routine logged a verdict line, and `crontab -l` shows the lines.

## 8. Hand over

Tell the user, briefly: where the workspace is, how to start a session (`cd <workspace> && claude`,
or the device in the Claude app), what runs on a schedule, which manual steps are still open, and
that a dead login is fixed by running `claude` and `/login` again. Offer to record the setup in
the coaching journal (`append_journal`, one entry: what runs where), and write it only if the user
agrees.

If a step of this guide was wrong or missing for this machine, offer to pass that upstream:
{{REPO_URL}}/issues. Describe the problem generically, with no personal data, hostnames or keys.
