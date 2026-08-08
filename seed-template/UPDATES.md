# Seed updates

Instructions to the coaching assistant for merging seed-template changes into
onboarded users' personalized documents. Entries are newest-last; each heading
starts with a monotonic integer id. `- Apply:` is `auto` (apply autonomously,
mention it briefly) or `propose` (apply only after the user agrees — the
default when omitted). `- Docs:` names the template files the entry stems from.

Editing this seed template? Any change onboarded users should receive gets an
entry here in the same commit — new users are stamped current at seed time and
never see entries from before their onboarding.

## 1 — 2026-07-13 — Editing & recovery guidance, Telegram quick-capture convention

- Docs: references/coaching-method, SKILL.md
- Apply: auto

The coaching-method reference gained a section "Editing documents & recovering
lost content" (placed before "## Guardrails"): change existing documents with
`edit_section` / `edit_reference` (exact-text replacement) instead of full
rewrites, and recover mistakenly lost content via `list_changes` /
`get_change` by re-applying it into the current document. Add that section to
the user's coaching-method reference verbatim — it is coach-facing method
text, not personal content.

SKILL.md's "Coaching conventions (proactivity)" list also gained two bullets
that this user's onboarding may predate; weave equivalents into the user's
conventions section, wherever their rewrite placed it, skipping any they
already have:

- Prefer `edit_section` / `edit_reference` for targeted changes; if content
  goes missing by mistake, recover it from the change history (see the
  coaching-method reference).
- Journal entries prefixed `[via Telegram]` are quick captures the person sent
  from their phone between sessions — review them at session start and pick
  them up like notes they told you.

## 2 — 2026-08-03 — start_session protocol, session close, journal entry format

- Docs: SKILL.md, references/coaching-method
- Apply: auto

The server gained a `start_session` tool (context + open items with OVERDUE
markers + latest journal entries in one call) and the template's session
protocol grew a mandatory close. Update the user's "Mandatory Session Start"
section (wherever their rewrite placed it):

- Replace the separate `get_coaching_context` + `list_open_items` calls with
  one `start_session` call, and add: read the returned journal part before
  coaching (last session's decisions and commitments are the starting point);
  follow up OVERDUE commitments first — resolve or renegotiate, never let
  items accumulate.
- Add a "Session Close" step list if the user has none: (1) one if-then
  commitment via `add_open_item` with `relevant_date` when dated, (2)
  `resolve_open_item` for what was handled, (3) `append_journal` per the
  journal format below.

The coaching-method reference gained a section "Journal entries (the coach's
session memory)" (first line = self-contained headline; then Decided /
Learned / Committed / Watch for; person's language; no date prefix; one entry
per session). Add it verbatim — coach-facing method text. It matters more now:
session start and search surface an entry's first line alone.

## 3 — 2026-08-03 — MI depth, anti-sycophancy, lapse protocol, referral red flags

- Docs: references/coaching-method
- Apply: auto

The coaching-method reference gained coach-facing method text; add the four
blocks essentially verbatim (they contain no personal content):

- "How I persuade" grew five techniques: importance/confidence rulers (0–10,
  work the answers), ask–tell–ask, developing discrepancy (goal vs. behavior,
  side by side, person reconciles), amplifying change talk instead of fighting
  sustain talk, and if-then rehearsal (person says the plan back once).
- New section "Holding the line (anti-sycophancy)": disagreement is a
  deliverable; pushback without new facts survives one restatement; never
  soften an assessment because it disappointed; validate the person, not every
  plan; repeated agreement with the person's preferences is a cue to
  re-examine.
- New section "Lapses & re-entry": lapse ≠ relapse; extract the trigger as
  data; the next step after a lapse gets smaller, never bigger; deliberate
  pauses with a re-entry date and paused routines; one guilt-free re-entry
  offer when the person goes quiet.
- Guardrails grew an explicit referral red-flag list (persistent pain,
  systemic illness, disordered-eating signs, mood deterioration/burnout,
  chronic sleep collapse → name it, recommend the right professional, don't
  resume coaching that area until addressed).

## 4 — 2026-08-03 — Metrics store, weekly-review upgrade, monthly goal review

- Docs: SKILL.md
- Apply: propose

The server gained a structured metrics store (`record_metric` /
`get_metrics` / `delete_metric`) for repeated numeric measurements — weight,
resting HR, adherence %, thresholds — replacing hand-edited markdown tables.
Propose to the user:

- Add a source-of-truth row: repeated measurements live in metrics, not in
  markdown tables; migrate existing measurement tables the next time one
  changes (record the history via `record_metric` with `measured_at`, then
  slim the table to a pointer).
- Upgrade their weekly review with: compare against last week's review (it is
  one journal call away); record per-topic adherence via `record_metric` so
  plan changes ride multi-week trends, not single-week verdicts; and a
  monthly goal-level review (first review of each month) walking the Active
  topics' review points — renegotiate or retire stale goals openly, and ask
  how the coaching itself is working for them.

## 5 — 2026-08-03 — Weekly-review routines anchor on the season plan; self-report daily check-in

- Docs: topics/training/routines/weekly-review, topics/training/routines/daily-checkin-selfreport
- Apply: propose

Topic-pack templates are delivered fresh on demand, so this entry is only
about content users already instantiated. For users of the **training**
topic:

- If they have a stored weekly-review routine, propose adding two things to
  its prompt: load `get_reference("season-plan")` at the start and judge the
  week against the current phase and next checkpoint (a season plan that no
  routine reads is write-only); and flag a checkpoint whose date passed
  without a target-vs-actual note (deduped open item) so the next interactive
  session reviews it. If the pack instantiated a `fitness-history` reference,
  also propose the quarterly staleness check (first review of a quarter →
  propose an update in the journal entry).
- If the person trains WITHOUT a fitness connector and has no daily routine,
  mention the pack now ships a `daily-checkin-selfreport` template
  (self-report loop via Telegram quick capture / journal) they can fetch via
  `get_topic_pack("training")`.
- For EVERY stored routine (any topic): propose replacing its context-loading
  step (`get_coaching_context` + separate `list_open_items` / `get_journal`
  calls) with one `start_session` call — same data, one round trip, journal
  payload bounded as history grows.

## 6 — 2026-08-03 — Ask the user to update their Claude project instructions

- Apply: propose

The one artifact the assistant cannot edit is the person's Claude **project
instructions** — they live in the user's own Claude account and most existing
users' instructions still bootstrap with `get_coaching_context` +
`list_open_items`. Until they are updated, the transition costs an extra
round trip (or a doubled context load) every single session.

Tell the person, once, in their language, roughly: "The coaching server got a
faster session start. Please update this project's instructions: replace the
session-start steps with the block below (everything else stays)." Then show
them this block, translated to their language:

> At the start of EVERY session — non-negotiable:
>
> 1. Call `start_session` first (it returns the coaching context, open items,
>    and recent journal in one call) and follow the operating procedure in
>    the returned context exactly.
> 2. Review the open items before coaching — OVERDUE ones first.
> 3. If the connector is unreachable, say so openly — never improvise
>    coaching from chat memory.

The same block is on the server's setup-guide page (the connector's base URL
in a browser). Until the person confirms the switch, avoid double-loading:
when the session already started via `get_coaching_context` (old
instructions), fetch `list_open_items` + `get_journal` (limit 5) individually
instead of calling `start_session` on top. Mark this entry applied once the
person has updated their instructions or explicitly declined.

## 7 — 2026-08-08 — Analysis workflow: data exports, chart discipline, stored scripts

- Docs: references/analysis-workflow
- Apply: auto

The server gained a data-analysis surface: Intervals.icu CSV export tools
(`icu_export_activities` / `icu_export_wellness` / `icu_export_weekly_summary`,
registered once the person connects Intervals.icu on their account page) and
a per-user script store (`list_scripts` / `get_script` / `save_script` /
`mark_script_verified` / `delete_script`) so analysis code survives between
sessions and derivation rules stay consistent.

Create the reference `analysis-workflow` via
`update_reference("analysis-workflow", …)` with exactly the content between
the BEGIN/END markers below — it is coach-facing method text with no
personal content. If the person does analytics-style sessions, also mention
the Intervals.icu connect option on the account page.

----- BEGIN analysis-workflow -----

# Analysis workflow (data, charts, scripts)

How to run data analyses and produce charts in coaching sessions. The server
never executes code — you (the assistant) execute in your own code-execution
sandbox; the server provides clean data exports and stores your analysis
scripts between sessions.

### Getting data into the sandbox

- Prefer aggregated exports over raw pulls. For weekly volume, sport split,
  or load-trend questions use `icu_export_weekly_summary` (when the person
  has connected Intervals.icu) — it applies the aggregation rules
  server-side, identically every time.
- Raw exports (`icu_export_activities`, `icu_export_wellness`) return
  compact CSV. Ask only for the date range and fields the question needs.
- Write CSV tool results into a sandbox file verbatim (`cat > data.csv
<<'EOF'` … `EOF`). **Never transcribe values by hand** — hand-copied data
  is the number-one source of silent errors.
- Structured personal measurements live in the metrics store
  (`get_metrics`); workout details come from the Hevy tools when connected.

### Producing charts

- Static charts: matplotlib → PNG. You can view the PNG you produced — look
  at it before delivering (overlapping labels, empty panels, wrong axes are
  visible to you).
- Interactive charts (artifacts): you cannot see the rendered result. Every
  number displayed — stat tiles, percentages, averages — must be computed
  inside the analysis script and copied from its output, never typed from
  memory. Hand-typed tile values have shipped wrong numbers before.

### Reusing analysis scripts

Consistency beats speed: the value of a stored script is that the same
derivation rules apply next month as today, and every change is visible in
change history.

1. Before writing an analysis from scratch: `list_scripts`, then
   `get_script` for anything that fits.
2. Run the stored script unchanged where possible. After a successful run,
   call `mark_script_verified` — the verification stamp is how the person
   knows the stored version can be trusted.
3. If you had to adapt it (new field, changed question), save the new
   version with `save_script`. Python is validated at save time: syntax
   errors reject the save, lint warnings deserve a fix. Saving changed code
   resets the verification stamp until it runs again.
4. Keep scripts parameterized. Personal parameter values — thresholds,
   corridors, baselines — are coaching decisions and live in the person's
   own documents (SKILL.md or a reference); the script takes them as inputs.
   A rule that lives only inside a script is invisible to routines and
   reviews.

### Size discipline

Tool results above roughly 150k characters do not reach the conversation
inline. The export tools refuse oversized results; respond by narrowing the
date range, trimming the field list, or switching to the weekly summary.
----- END analysis-workflow -----
