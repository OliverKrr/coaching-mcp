# Scheduled routine templates

Coaching gets much stronger when Claude doesn't only respond but also _checks in_: a weekly
review, an evening briefing for tomorrow's session, a morning readiness check. These run as
**scheduled tasks in each user's own Claude account** — the coaching server is passive and never
initiates a conversation, so routines are per-user by construction: every athlete schedules their
own, against their own coaching database.

## How to set one up

1. Connect the coaching server as a custom connector (and, if you have one, your fitness-data
   connector — e.g. an intervals.icu or similar MCP connector).
2. In Claude, create a scheduled task at the cadence given at the top of the template.
3. Paste the template as the task prompt, fill the `[placeholders]`, and delete anything that
   doesn't apply (e.g. the fitness-connector steps if you don't have one).

## Conventions shared by all three templates

- **Language:** all athlete-facing output (pushes, journal entries, summaries) is written in the
  athlete's **preferred language as recorded in the coaching context** (Snapshot). The template
  text itself stays English; what the athlete reads does not.
- **Unattended:** routines never ask questions. If required data is missing, they degrade or stay
  silent rather than guess.
- **Transient-outage guard:** if a coaching-server call times out or errors, retry 2–3× with ~5 s
  between attempts. If it stays unreachable, don't half-produce output — note the outage (in a
  journal entry if reachable) and stop; the next run picks it up.
- **Division of labour:** the weekly review writes the check-in of record; the evening preview
  briefs tomorrow's quality session; the morning check raises readiness _flags only_. No
  double-briefing, no duplicate flags (`dedup_key`).

| Template               | Cadence                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `weekly-review.md`     | weekly, e.g. Sunday evening                                        |
| `evening-preview.md`   | daily, e.g. ~20:30 (push only when tomorrow has a quality session) |
| `morning-readiness.md` | daily, shortly after overnight wearable data lands                 |
