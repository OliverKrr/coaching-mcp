# Routine Design

How to design, adjust, and retire scheduled check-in routines. Load this whenever the person
wants recurring support ("check in on me weekly", "help me plan meals every week") or an
existing routine needs revisiting. Grounded in behavior-change research (implementation
intentions/WOOP, JITAI, habit-formation and goal-disengagement literature).

## The model

A routine is a **stored prompt** the person runs as a scheduled task in their own Claude
account. This server never starts conversations. The division of labor:

1. Design the routine together in a normal session (this document).
2. Store it via `save_routine` (name, cadence, prompt) — prompt written in the person's
   preferred language.
3. The person creates the scheduled task in Claude and pastes the prompt (also copyable from
   their account page). Revisions: edit + re-save + they re-paste. `status` tracks whether it's
   actually scheduled ('active') or not ('paused'/'retired').

Platform reality check: scheduled tasks run at most ~hourly and consumer plans cap daily runs —
so design **few, high-value routines**, not many small ones.

## Designing a routine (work through with the person)

1. **Goal & timeframe (WOOP).** What outcome, by when, why does it matter to them (their words),
   what is the most likely obstacle, and what is the if-then plan for that obstacle. A routine
   without a timeframe and review point runs forever and decays into noise.
2. **Cadence.** Match the tier, don't default to daily:
   - _daily_ — only for active habit installation or self-monitoring prompts, and time-boxed
     (~8–10 weeks; then the reminder should fade so the natural cue takes over);
   - _weekly_ — the workhorse for reviews and planning (training week, meal planning);
   - _monthly+_ — goal-level "is this still the right goal" reviews.
     Anchor timing to the person's existing rhythm (before their shopping day, Sunday planning
     hour, after wearable data syncs) — routine-based cues beat arbitrary clock times.
3. **Connectors & data.** Which sources the routine reads (this coaching server; any data
   connector the person has). If a source is missing, the routine must degrade gracefully, never
   guess.
4. **Output contract.** What it writes (journal entry? flags with dedup keys?) and what it
   pushes. One push = the single most important thing, closed with one concrete action.
5. **Silence conditions.** When does it send nothing? Silence is a first-class outcome — pushing
   without substance erodes trust faster than not pushing at all.
6. **Review point.** When do we check whether the routine still earns its cadence (typically at
   the weekly review, and hard-review at the goal's timeframe).

## Prompt conventions (every routine prompt includes these)

- **Unattended:** never ask questions; if required data is missing, degrade or stay silent.
- **Language:** write all person-facing output in the preferred language from the coaching
  context.
- **Outage guard:** retry failed coaching-server calls 2–3× (~5 s apart); never half-produce
  output; note outages briefly rather than inventing data.
- **Anchor the date** from a reliable source before any scheduling statement; never infer it.
- **De-duplicate:** check `list_open_items` first; raise flags via `add_open_item` with a stable
  `dedup_key`; never re-raise an open flag.
- **Division of labor:** each routine owns its slice; no double-briefing across routines, and
  don't stack multiple pushes on the same day.
- **Check-in shape:** affirm first (acknowledge effort and partial wins), then data
  insights-first, then ONE focus for the next period, then the obstacle's if-then plan, then a
  light self-monitoring prompt (consistency beats completeness).
- **Why-now transparency:** when the routine does push, include a one-line reason it fired
  ("weekly review", "HRV gate tripped") — unexplained proactive contact erodes trust.
- **Lapse-tolerant:** a missed week gets a smaller re-entry step, never guilt or streak-reset
  framing; frame consistency as "5 of 7 days", not broken chains.

## Lifecycle

- **Adjust:** cadence too chatty or content stale → revise the prompt, re-save, person updates
  the task. Prefer decaying cadence (weekly → biweekly → monthly) as the behavior stabilizes.
- **Celebrate & retire:** goal reached → celebrate, then retire the routine or convert it to a
  lighter maintenance cadence.
- **Renegotiate:** several check-ins with no progress or engagement → the routine (and the
  coach) should propose renegotiating the goal or retiring the routine rather than nagging.
  Disengagement can be success — the habit may have internalized.
- Retire via `save_routine` with status `retired` (keeps history) rather than deleting; the
  person removes the scheduled task themselves.
