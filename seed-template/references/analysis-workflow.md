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
