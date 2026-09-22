# Zones Reference — [Athlete Name]

Full zone tables. The threshold values themselves are metric series (`get_metrics`), dated and
with their history; this file derives the zones from them. When a threshold is re-recorded,
recompute the affected table here and update its "Anchored on" line to match.

## Zone Target Selection Rule

[Which target type is primary per sport and session type — e.g. "run intervals by pace, easy runs
by HR cap; bike everything by power". Fill during onboarding.]

## [Primary sport] zones

| Zone | Name             | [Pace/Power/HR] range | Feel / use     |
| ---- | ---------------- | --------------------- | -------------- |
| Z1   | Recovery         | [..]                  | [..]           |
| Z2   | Easy / endurance | [..]                  | conversational |
| Z3   | Tempo            | [..]                  | [..]           |
| Z4   | Threshold        | [..]                  | [..]           |
| Z5   | VO2max+          | [..]                  | [..]           |

Anchored on: [series and value, e.g. `threshold-pace` 265 s/km, from test/race on date].

## [Secondary sport] zones

[Table as above, or delete.]

## Quick conversion table

[Handy equivalences the athlete uses, e.g. min/km ↔ km/h, %FTP ↔ watts. Optional.]
