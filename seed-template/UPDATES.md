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

## 8 — 2026-08-24 — Abstention: a weak retrieval hit is not evidence

- Docs: SKILL.md, references/coaching-method
- Apply: auto

Knowing that something was NEVER said is the one thing a curated knowledge
base does better than any retrieval system — protect it explicitly. The
coaching-method reference's "Journal entries" section gained a closing
bullet: **"No record means no record."** A weak or empty journal/search hit
is not evidence a session happened or something was said; retrieval almost
always surfaces something plausible, and a coach who confabulates a session
is worse than one who says "I have no record of that; tell me what
happened." Executed training lives in the source-of-truth map's topic data
(training platform or the person's own report), never in the coach's memory
of it. Add that bullet to the user's coaching-method reference verbatim —
coach-facing method text, not personal content.

SKILL.md's "Coaching conventions (proactivity)" list gained the matching
bullet; weave an equivalent into the user's conventions section (wherever
their rewrite placed it), skipping it if they already have one:

- A weak search or journal hit is **not evidence** — never treat "something
  similar came back" as "it happened". No record → say so and ask (see
  `coaching-method`, journal entries).

## 9 — 2026-08-25 — The script store is retired; analysis code lives in the assistant's environment

- Docs: references/analysis-workflow
- Apply: auto

v3 removes the stored-scripts feature (`list_scripts`, `get_script`,
`save_script`, `mark_script_verified`, `delete_script`). Analysis code now
lives where it can be versioned and tested — a repository or project the
person maintains with the assistant — while the server keeps what it is
good at: clean data exports plus the durable _results_ (journal entries,
metrics, reference documents).

Nothing was lost: on the server upgrade every stored script was written
into the change history as a `script` delete record — recover any content
with `list_changes` (kind `script`) → `get_change`, and move it into the
person's analysis environment or, failing that, record its derivation
rules in a reference document.

Update the user's analysis-workflow reference (wherever their rewrite
placed it): replace the "Reusing analysis scripts" section (the
list_scripts/save_script/mark_script_verified workflow) with the new
"Keeping analyses consistent between sessions" guidance from the template —
durable code lives outside the server; parameters stay in the person's
documents; results go to journal + metrics. Remove any other mention of the
script tools from their documents, and if they had stored scripts, offer
the recovery path above once.

## 10 — 2026-08-27 — Session start is tiered by topic; scoped start_session

- Docs: SKILL.md
- Apply: auto

The "Mandatory Session Start" rule gains a scope exception, and `start_session`
gains a `scope` parameter (`full` default, `context`, `items`) so scheduled
runs can ask for only the slice they use.

Update the user's session-start section (wherever their rewrite placed it):

- Add the scope exception verbatim in spirit: work that touches **no coaching
  data** — repo, tooling, deployment, routine plumbing — may skip
  `start_session` and call only the tools it needs; the moment a conversation
  touches training, planning, personal facts, or coaching-document writes,
  `start_session` runs first. Never answer a coaching question from memory;
  the topic judgment happens before context is loaded, so it stays
  conservative — when in doubt, it counts as coaching.
- Where their routines' prompts call `start_session`, mention the `scope`
  parameter for runs that need only open items or only the context.

Also suggest the person updates their Claude project instructions from the
setup page — the recommended block gained the same exception, and the two
must not drift.

## 11 — 2026-08-30 — Journal corrections and archiving; routines wait for ripeness

- Docs: SKILL.md, references/coaching-method, references/routine-design
- Apply: auto

The server gained two journal tools. `correct_journal(entry_id, correction)` attaches a
correction to an existing entry — the original text is never changed, and every read path
(`get_journal` in any format, `start_session`, `search_knowledge` hits) returns the two
together. `archive_journal(ids)` marks entries as archived: they collapse to headlines at
session start and in `get_journal` listings, stay fully findable via `search_knowledge`, and
still come back in full via `get_journal` with `ids`. There is still no way to delete a journal
entry, and that is deliberate.

Update the user's documents (wherever their rewrite placed the equivalent sections):

- Coaching conventions: add a bullet — an entry that turns out to be wrong gets
  `correct_journal`, never a new entry saying an older one was wrong, because the reader has to
  find that entry first and believes the wrong one until they do.
- The coaching-method reference's journal section gained "Correcting an entry, and retiring one
  from session start" — add it: correct as soon as the truth is established and write what is
  actually true (not "the above is wrong"); archive a period's entries only **after** its
  substance has been condensed into a reference document; nothing is ever deleted.
- The routine-design reference gained two design rules that came out of routines writing wrong
  facts into the journal. (a) A routine reading a record that someone or something else is still
  editing must wait for a **ripeness signal** — a field only the person fills in, an interaction
  that happens later — never a timer, and the safety-relevant half that needs only immediately
  final data runs at once. (b) A stored cadence carries the timezone it is meant in, because a
  UTC-only scheduler drifts by an hour at every daylight-saving switch.
- If the person has routines that read a third-party record shortly after an event (workout
  gear, activity titles, order status), offer once to split them along the ripeness rule.

Also mention, only if it comes up: the server's own feedback invitation now says to check that
the session can actually file a GitHub issue before promising one, and to hand over a
ready-to-paste issue body otherwise.

## 12 — 2026-08-30 — A push that is too long is lost, not shortened

- Docs: references/coaching-method, references/routine-design
- Apply: auto

Delivery has hard limits and none of them trim anything: `notify_user` refuses a message over
4096 characters, and a relay that forwards a scheduled run's output to the phone can only read a
truncated copy of that output — a careful relay then sends nothing at all rather than a cut-off
report. So an over-long final message is not a longer push, it is a missing one.

Update the user's documents (wherever their rewrite placed the equivalent sections):

- The coaching-method reference's delivery mechanics gained a bullet saying exactly that: write
  the push as a push (headline, one read, one action, a few hundred characters) and leave the
  full write-up in the journal or a reference, with the push pointing at it.
- The routine-design reference's output contract now asks for an **explicit character budget for
  the push, written into the routine's prompt**.
- Then check the person's existing routines: any whose final message IS the push and which
  currently produces a full report needs that budget added to its prompt, and its report moved
  into a journal entry. Offer this once, name the routines you found, and let them decide.

## 13 — 2026-09-22 — Training thresholds and personal bests move to dated metrics

- Docs: topics/training/topic, topics/training/references/zones
- Apply: propose

The training pack no longer seeds "Thresholds" and "Personal Bests" value tables into `main`.
Each threshold and PB is now a `state` metric series: a new value supersedes the old one and the
old one stays readable (`get_metrics` with `as_of` or `include_superseded`). A table that gets
overwritten on every retest loses the starting value a block has to be judged against, and a
`Last verified` column nobody reads does not stop a plan being built on an outdated FTP.

Entry 4 already asked for measurement tables to move to metrics "the next time one changes".
Thresholds change rarely, so for users of the **training** topic whose `main` (or `zones`
reference) still carries such tables, propose migrating them now:

1. Record each threshold via `record_metric` with `series_kind: "state"`, its `measured_at` set
   to the date it was set (the table's date column, not today), and `stale_after_days` set to
   the retest cadence the person agrees to (ask; 90 is a reasonable default). Record older
   values first if the table or the journal still has them, so the trail starts early.
2. Record each personal best the same way, as a `state` series without `stale_after_days`.
   Pace and times in seconds, units fixed per series.
3. Replace the tables in `main` with the short "Thresholds & personal bests" section from the
   training pack (`get_topic_pack("training")`): the series names in use, the staleness rule,
   and the rule to record new values instead of editing them. Add a source-of-truth row naming
   metrics as the home of thresholds and PBs.
4. In the `zones` reference, point each "Anchored on" line at the series and value it derives
   from.

From then on, session start flags a threshold that has outlived its window. Treat a flagged
value as unverified until it is retested, confirmed against current data, or re-recorded.

## 14 — 2026-09-22 — Holding the line: argue from the record

- Docs: references/coaching-method
- Apply: auto

The coaching-method reference's "Holding the line (anti-sycophancy)" section gained a bullet,
placed before "Watch for drift". Pushback that rests on an impression folds at the first
objection; pushback that rests on a dated number gives both sides something to check. Add it to
the user's coaching-method reference verbatim (translated into their language if the reference
is written in it); it is coach-facing method text, not personal content:

- **Argue from the record.** Pushback holds when it rests on a dated number, not an impression.
  Before endorsing or challenging a goal or plan, read the relevant values (`get_metrics`, a
  checkpoint, a race result) and put the comparison into the reply: "your half-marathon best is
  1:38 from April; a sub-3 marathon in twelve weeks needs a much faster half than that". With no
  record to compare against, say that the claim can't be checked and ask for the number, rather
  than agreeing by default.

## 15 — 2026-09-22 — Season plan block log: intent, starting values, verdict

- Docs: topics/training/references/season-plan, topics/training/topic, topics/training/routines/weekly-review
- Apply: propose

The training pack's `season-plan` reference gained a "Block log" section between the phase table
and the checkpoints. The phase table says what the plan is; the log records, per block, what it
was for, the metric values it started from, the confounders that got in the way, and a verdict
at the end that compares the same series again. Without the intent and starting values written
down up front, a block can only be judged by impression, or by counting completed sessions,
which says nothing about whether fitness moved.

For users of the **training** topic, propose:

1. Add the "Block log" section to their `season-plan` reference (skeleton in
   `get_topic_pack("training")`), in their language.
2. Open an entry for the block they are in now. Agree the intent with them. For the starting
   values, read the series as they stood when the block began (`get_metrics` with `as_of` = the
   block's start date), not today's values. If the series didn't exist yet (entry 13's
   migration still pending), write the values the journal or old tables recorded and say where
   they came from.
3. If they have a stored weekly-review routine, propose extending its staleness checks: flag a
   block whose end date passed without a verdict, or a running block with no entry (deduped open
   item, e.g. `block-verdict-<name>`), and note this week's confounders in the journal entry as
   proposed block-log additions. The routine proposes; the log itself is edited in an
   interactive session.
