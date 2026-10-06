#!/usr/bin/env bash
# Run one coaching routine as a headless Claude Code turn. Started by cron; see scripts/README.md.
#
#   run_routine.sh <routine-name> [extra context]
#
# The prompt comes from scripts/routines/<name>.md when that file exists. Otherwise the run fetches
# the routine stored on the coaching server (get_routine) and carries out its prompt, so routines
# designed in chat run here unchanged.
#
# The run's last line is its verdict, and the only thing this script trusts:
#   DELIVERED — ...   the result reached the user (a notify_user push or a journal entry)
#   SILENT — ...      nothing worth reporting, deliberately quiet
#   FAILED — ...      the routine could not do its job
# Anything else counts as a failure. A routine that fails without saying so is the failure mode
# this whole setup exists to catch.
#
# Configuration: scripts/routines/config.env (committed, no secrets). Optional healthchecks.io
# pings: healthchecks.env at the repo root, one `<routine-name>=<ping url>` per line (gitignored).

set -uo pipefail

NAME="${1:?routine name required}"
EXTRA="${2:-}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
[ -r "$REPO/scripts/routines/config.env" ] && . "$REPO/scripts/routines/config.env"

COACHING_SERVER="${COACHING_SERVER:-mcp__claude_ai_Coaching}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
ROUTINE_TIMEOUT="${ROUTINE_TIMEOUT:-2700}"
ROUTINE_MODEL="${ROUTINE_MODEL:-}"
ROUTINE_START_GAP="${ROUTINE_START_GAP:-20}"

PROMPT_FILE="$REPO/scripts/routines/${NAME}.md"
TOOLS_FILE="$REPO/scripts/routines/${NAME}.tools"
LOG="$REPO/data/routines.log"
mkdir -p "$REPO/data"

log() { printf '%s [%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$NAME" "$1" >>"$LOG"; }

hc_ping() { # $1 = '' | /start | /fail
  local url=""
  [ -r "$REPO/healthchecks.env" ] &&
    url=$(grep -E "^[[:space:]]*${NAME}[[:space:]]*=" "$REPO/healthchecks.env" | head -1 | cut -d= -f2- | tr -d '[:space:]')
  [ -n "$url" ] && command -v curl >/dev/null && curl -fsS -m 10 --retry 3 -o /dev/null "${url}${1}" || true
}

finish() { # $1 = healthchecks suffix, $2 = exit code, $3 = log line
  log "$3"
  hc_ping "$1"
  exit "$2"
}

# Locks need flock (util-linux; on macOS brew install flock). Without it runs are not serialized.
have_flock() { command -v flock >/dev/null; }

# One routine at a time per name.
if have_flock; then
  exec 9>"${TMPDIR:-/tmp}/run_routine.${NAME}.lock" || exit 0
  flock -n 9 || { log "skipped, previous run still active"; exit 0; }
fi

# No two claude starts in the same moment. Every process of this user shares one claude.ai login
# whose refresh token rotates: two simultaneous refreshes can invalidate it, and then every run
# fails until an interactive /login. The gate lets one start through and holds the lock for
# ROUTINE_START_GAP seconds, long enough for that start to finish its refresh.
claude_start_gate() {
  have_flock || return 0
  exec 8>"${TMPDIR:-/tmp}/claude-start.lock" || return 0
  flock -w 300 8 || log "start lock still busy after 300s, starting anyway"
  sleep "$ROUTINE_START_GAP" >/dev/null 2>&1 9>&- &
  exec 8>&-
}

if [ -r "$PROMPT_FILE" ]; then
  prompt=$(cat "$PROMPT_FILE")
else
  prompt="You are running the scheduled coaching routine \"${NAME}\" unattended: nobody will answer
questions. Call get_routine with name \"${NAME}\" on the coaching server and carry out its prompt
exactly. If no routine with that name exists, stop."
fi
prompt="${prompt}

---

Unattended run. When you are done, print exactly one final line, and nothing after it:
DELIVERED — <what reached the user and how>   (a notify_user message, or a journal entry when notify_user is not available)
SILENT — <why nothing was worth reporting>
FAILED — <what went wrong>"
[ -n "$EXTRA" ] && prompt="${prompt}

---

Context passed by the trigger: ${EXTRA}"

# Word splitting is the point: the file holds a space-separated tool list.
tools="$COACHING_SERVER"
[ -r "$TOOLS_FILE" ] && tools="$COACHING_SERVER $(cat "$TOOLS_FILE")"

args=(-p "$prompt" --add-dir "$REPO")
[ -n "$ROUTINE_MODEL" ] && args+=(--model "$ROUTINE_MODEL")
# shellcheck disable=SC2206
args+=(--allowedTools $tools)

runner=()
if command -v timeout >/dev/null; then
  runner=(timeout "$ROUTINE_TIMEOUT")
elif command -v gtimeout >/dev/null; then # macOS: brew install coreutils
  runner=(gtimeout "$ROUTINE_TIMEOUT")
fi

# Run outside the checkout, so the turn does not load CLAUDE.md, which is written for interactive
# sessions; --add-dir still gives it the repo.
cd "$HOME" || cd / || exit 1

log "start"
hc_ping /start
claude_start_gate
started=$(date +%s)
out=$(${runner[@]+"${runner[@]}"} "$CLAUDE_BIN" "${args[@]}" 2>&1)
rc=$?
printf '%s\n' "$out" >>"$LOG"
log "finished after ~$(($(date +%s) - started))s (exit ${rc})"

[ "$rc" -eq 124 ] && finish /fail 1 "timed out after ${ROUTINE_TIMEOUT}s"
if [ "$rc" -ne 0 ]; then
  case "$out" in
    *"Failed to authenticate"* | *"logged in"*) finish /fail 1 "claude is not logged in: run claude, then /login" ;;
    *"You've hit your"*) finish /fail 1 "usage limit reached" ;;
  esac
fi

marker=$(printf '%s\n' "$out" | grep -Eo '^(DELIVERED|SILENT|FAILED).*' | tail -1)
case "$marker" in
  DELIVERED* | SILENT*) finish "" 0 "$marker" ;;
  FAILED*) finish /fail 1 "$marker" ;;
  *) finish /fail 1 "no verdict line in the output, treating as failed" ;;
esac
