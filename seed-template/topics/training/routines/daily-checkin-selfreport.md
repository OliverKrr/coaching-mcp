# Daily Check-in (self-report, no fitness connector)

Cadence: daily, evening (e.g. ~19:30) — time-boxed to ~8–10 weeks, then decay to weekly

The connector-free counterpart to the morning-readiness and evening-preview routines: a
self-reporting athlete has no wellness feed to evaluate, so this routine closes the loop the
other way — it invites a one-line self-report and reads yesterday's. Works best when the person
has linked Telegram (replies land in the journal as `[via Telegram]` quick captures); without
Telegram, replies in the run's chat also reach the journal at the next session. Tailor the
bracketed parts and store the instantiated prompt in the person's preferred language via
`save_routine`.

---

Connectors: coaching server only — deliberately no fitness connector.
Unattended — work silently, do not ask blocking questions; the push's closing invitation IS the
question. Write every athlete-facing sentence in the athlete's preferred language from the
coaching context.

Transient-outage guard: if a coaching-server call times out or errors, retry 2–3× with ~5 s
between attempts. If it stays unreachable, end with the one quiet line noting the coaching
server was down — never invent data.

1. Load context: start_session (coaching context with training framework, week skeleton and
   patterns, open items, and the recent journal — one call) and
   get_reference("coaching-method"). Anchor today's date [name the person's date source —
   there is no connector profile]; never infer it.
2. Read yesterday's self-reports from the returned journal part — pick up `[via Telegram]`
   captures and any reported session, sleep, soreness, stress, or skipped workout (older
   headlines in full via get_journal ids if needed).
3. Evaluate what was reported (self-report replaces the wellness feed):
   - Reported multi-day fatigue, poor sleep, or rising soreness → add_open_item (kind=flag,
     source=daily-checkin, dedup_key=[e.g. "fatigue-<YYYY-Www>"], one line: what + recommended
     action). Never re-raise an open flag — start_session already listed the open ones.
   - A reported hard-session-tomorrow conflict with reported fatigue → make tomorrow's session
     conditional in the push, in plain words.
   - Nothing reported for [3+] days → one warm nudge in the push, never guilt (see
     coaching-method → Lapses & re-entry).
4. Compose the push per coaching-method → "Writing a proactive push": one short paragraph —
   today acknowledged (affirm what was reported done), tomorrow's intention from the week
   skeleton (one clause), then close on the invitation that does the self-monitoring work:
   ask for one line back — [e.g. "session done? sleep, fatigue, soreness, stress 1–5 — one
   line to the bot is enough"]. Consistency beats completeness; one line is the whole ask.
5. End the run on that message (final message = notification; first line lock-screen-proof).
   If there is genuinely nothing to say and nothing was reported for weeks, end with the one
   quiet line — and at the next weekly review propose decaying or retiring this routine per
   `routine-design` (disengagement can mean the habit internalized).
