# Scheduled routine templates

Coaching gets much stronger when Claude doesn't only respond but also _checks in_: a weekly
review, an evening briefing for tomorrow's session, a morning readiness check. These run as
**scheduled tasks in each user's own Claude account** — the coaching server is passive and never
initiates a conversation, so routines are per-user by construction: every athlete schedules their
own, against their own coaching database.

**The templates live in `src/routine-templates.ts`** (single source of truth, English and German)
and are served ready-to-copy on the server's **`/routines` page** (`<PUBLIC_URL>/routines`,
bilingual via `?lang=de|en` / Accept-Language, linked from the landing-page setup guide). Point
users there rather than at this repo.

## Conventions shared by all three templates

- **Language:** the template _prompt_ exists in English and German; the routine's _output_
  (pushes, journal entries, summaries) is always written in the athlete's preferred language as
  recorded in the coaching context, regardless of prompt language.
- **Unattended:** routines never ask questions. If required data is missing, they degrade or stay
  silent rather than guess.
- **Transient-outage guard:** coaching-server calls are retried 2–3× before giving up; a routine
  never half-produces output.
- **Division of labour:** the weekly review writes the check-in of record; the evening preview
  briefs tomorrow's quality session; the morning check raises readiness _flags only_. No
  double-briefing, no duplicate flags (`dedup_key`).
- **No fitness connector?** The data-pull steps are marked as `[placeholders]` — users without
  one delete those steps; the routines still work from the journal and open items.

| Template                    | Cadence                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Weekly Review               | weekly, e.g. Sunday evening                                        |
| Evening Pre-Session Preview | daily, e.g. ~20:30 (push only when tomorrow has a quality session) |
| Daily Readiness             | daily, shortly after overnight wearable data lands                 |
