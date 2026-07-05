# Scheduled routines

Coaching gets much stronger when the assistant doesn't only respond but also _checks in_: a
weekly review, a meal-planning check-in, a morning readiness check. These run as **scheduled
tasks in each user's own Claude account** — the coaching server is passive and never initiates a
conversation, so routines are per-user by construction.

## The model (v3)

Routines are **per-user documents** stored in the coaching database:

1. **Design** — the user asks their coach for recurring support in a normal session. The
   assistant loads the `routine-design` seed reference (best practices: goal + timeframe,
   cadence tiers, silence-by-default, lifecycle/retirement) and designs the prompt with the
   user, in the user's preferred language.
2. **Store** — `save_routine(name, cadence, prompt, status)`. Listed/edited via
   `list_routines`/`get_routine`, on the account page (`/account/data/routines`), and included
   in the data export.
3. **Schedule** — the user copies the stored prompt into a Claude scheduled task (from the chat
   or the account page). Scheduled tasks cannot be created programmatically from a connector,
   so this copy step is deliberate. `status` tracks the bookkeeping: `active` = scheduled,
   `paused`/`retired` = not.
4. **Iterate** — adjust = revise + re-save + re-paste; retire = status change + user deletes
   the scheduled task.

**Templates** are raw material behind the MCP: each topic pack ships English master templates
under `seed-template/topics/<id>/routines/*.md` (`# Title` + `Cadence:` line + prompt body).
They carry the shared conventions — unattended (never ask questions), transient-outage guard,
dedup keys via open items, division of labor between routines, insights-first output, one push =
one action. The assistant tailors and translates them at instantiation time; there are no
per-language template copies.

The server's `/routines` page explains this flow to users and renders the pack templates as
reference material.
