# Routine template: Daily Readiness (morning check)

Schedule: daily, [~15 min after your overnight wearable data typically reaches your fitness
platform — check once on a normal morning].
Connectors: coaching server; a fitness-data connector with wellness data [e.g. intervals.icu].
Unattended — work silently, do not ask questions. **Flags only**: do NOT prescribe workouts, edit
references, or write a journal entry. Pre-session intentions are the evening routine's job.
Write any push in the athlete's preferred language from the coaching context.

**Transient-outage guard:** if a coaching-server call times out or errors, retry 2–3× with ~5 s
between attempts. If it's still unreachable, evaluate only the load-based flags and note in any
push that the coaching server was down.

1. Load context: `get_coaching_context` (patterns & lifestyle rules) and
   `get_reference("injuries")`. Anchor today's date [from the fitness connector's profile].
2. Pull signals [from the fitness connector]: wellness (last ~7 days — HRV, RHR, sleep),
   fitness/load (last ~21 days), recent training history (adherence / missed quality).
3. **Data-sync guard.** Check that last night's wellness row is actually present. If it is NOT
   synced yet, do not infer anything from its absence: skip the HRV/RHR/sleep flags this run,
   evaluate only the load-based flags, and if you push, note that overnight data wasn't in yet.
   **Never raise a flag off missing data.**
4. Check existing open flags FIRST: `list_open_items kind=flag` — never re-raise an open flag.
5. Evaluate the rules (raise only if the rule holds AND no open flag shares the dedup_key) —
   `add_open_item` (kind=flag, source=morning-readiness, dedup_key, relevant_date, content = one
   line: what + recommended action). Adapt the rule set and thresholds to the athlete's
   `injuries` reference and patterns; typical examples:
   - **HRV/RHR prodrome** — HRV below [athlete's gate] for 2+ consecutive days, OR RHR above
     [baseline + margin] for 2+ days → `hrv-low-<YYYY-Www>`. Gate quality until stable; protect
     sleep.
   - **Sustained high load** — chronic load above [athlete's illness-risk threshold] for
     [duration] → `load-high-<YYYY-Www>`. Schedule a recovery week.
   - **Injury-risk window** — [athlete-specific trigger combination from the injuries reference]
     → `injury-risk-<YYYY-Www>`. Remove the stacked trigger.
   - **Missed quality** — a planned quality session in the last few days with no matching
     completed activity → `missed-quality-<YYYY-Www>`. Surface for rescheduling.
6. Push ONLY if a NEW flag was raised. First load `get_reference("coaching-method")`, then
   compose the push per its "Writing a proactive push": lead with what to _do_ about it, the
   single most important flag only, closed with one concrete action. Two plain lines is plenty.
   Nothing warranted → send nothing and end silently.
