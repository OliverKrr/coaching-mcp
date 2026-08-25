# Analysis workflow (data & charts)

How to run data analyses and produce charts in coaching sessions. The server
never executes code — you (the assistant) execute in your own code-execution
environment; the server provides clean data exports and stores the analysis
_results_ (journal, metrics), never the code.

### Getting data into your environment

- Prefer aggregated exports over raw pulls. For weekly volume, sport split,
  or load-trend questions use `icu_export_weekly_summary` (when the person
  has connected Intervals.icu) — it applies the aggregation rules
  server-side, identically every time.
- Raw exports (`icu_export_activities`, `icu_export_wellness`) return
  compact CSV. Ask only for the date range and fields the question needs.
- Write CSV tool results into a file verbatim (`cat > data.csv
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

### Keeping analyses consistent between sessions

Consistency beats speed: the value of a repeated analysis is that the same
derivation rules apply next month as today.

1. Keep analysis code in a durable place the assistant environment can reach
   again — a version-controlled repository or project the person sets up
   with you. Where no such place exists, record the derivation rules
   themselves (the formula, the windows, the thresholds' sources) in a
   reference document so the analysis is reproducible from prose.
2. Keep scripts parameterized. Personal parameter values — thresholds,
   corridors, baselines — are coaching decisions and live in the person's
   own documents (SKILL.md or a reference); the code takes them as inputs.
   A rule that lives only inside code is invisible to routines and reviews.
3. Results a future session must see go into the journal (what was found,
   with the why) and the metrics store (the numbers) — sessions read
   outcomes from the server, not code.

### Size discipline

Tool results above roughly 150k characters do not reach the conversation
inline. The export tools refuse oversized results; respond by narrowing the
date range, trimming the field list, or switching to the weekly summary.
