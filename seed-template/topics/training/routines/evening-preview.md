# Evening Pre-Session Preview

Cadence: daily, e.g. ~20:30 — push only when tomorrow has a quality session

Briefs tomorrow's quality session the evening before. Requires a fitness-data connector with the
training plan. Tailor the bracketed parts and store the instantiated prompt in the person's
preferred language via `save_routine`.

---

Connectors: coaching server; a fitness-data connector with the training plan
[e.g. intervals.icu].
Unattended — work silently, do not ask questions. Push only when tomorrow has a quality session;
otherwise send nothing. Write the push in the athlete's preferred language from the coaching
context.

Transient-outage guard: if a coaching-server call times out or errors, retry 2–3× with ~5 s
between attempts. If it's still unreachable but the plan clearly shows a quality session
tomorrow, send a minimal intention from the plan + zone rules; otherwise stay silent.

Purpose: brief tomorrow's quality session the evening before, so the intention arrives in time
even for an early-morning workout. Each quality session is briefed once, here — the morning
readiness routine does NOT brief sessions.

1. Load context: get_coaching_context (training framework, zone-target rules) and
   get_reference("coaching-method"). Anchor today's date [from the fitness connector's profile];
   determine tomorrow's date.
2. Check tomorrow's plan [fitness connector events + the weekly anchors from the coaching
   context] for a planned quality session. None → end silently, no push.
3. Read readiness context: [recent wellness — HRV/RHR/sleep — from the fitness connector] and
   list_open_items kind=flag (any open readiness flag or recovery gate).
4. Compose the pre-session intention per coaching-method → "Writing a proactive push": a short,
   warm paragraph that leads with the call — no jargon, no labels. Fold in as prose: what
   adaptation tomorrow's session targets (the why, one clause); the right target metric per the
   zone rules, adjusted for any open readiness flag and for conditions (an open recovery gate
   makes the session conditional in plain words; extreme weather gets a moved time window or an
   adjusted target); close on the one morning if-then action. Push-only — do NOT store the
   intention as an open item.
5. Push it as that one short message. Nothing tomorrow → nothing sent.
