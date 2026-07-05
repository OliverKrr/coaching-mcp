# Endurance & Strength Training

Coaching for endurance sports (running, cycling, triathlon, …) and supporting strength work:
goals and events, thresholds and zones, a weekly training framework, workout construction, and
injury awareness.

> **Instantiation instructions to the coaching assistant:**
>
> 1. Run the interview below conversationally (a few questions at a time, not a form), in the
>    person's preferred language.
> 2. Write each reference skeleton via `update_reference`, tailored to the person — delete
>    whole references that don't apply (e.g. `strength` for someone who won't do strength work).
> 3. Weave the section skeleton below into section `main` (under "Topic sections"; renumber as
>    needed), replacing placeholders with interview answers; write `TBD` for unknowns.
> 4. In `main`: add this topic with its goal and review point to the snapshot's Active-topics
>    table; add a source-of-truth row for completed workouts (training platform, or "reports
>    manually"); add the topic's reference rows to the reference table.
> 5. Offer the routine templates in this pack (tailored, in the person's language, stored via
>    `save_routine` per the `routine-design` reference) — they are optional.

## Interview

1. **Goals & events** — primary sport(s); the goal that matters most this season and long-term;
   target events with dates.
2. **Background** — training age, past events and results, what has and hasn't worked before.
3. **Current fitness** — recent test results or race performances; known thresholds (pace,
   power, heart rate); typical weekly volume.
4. **Schedule & constraints** — days/hours available, fixed commitments, preferred days for long
   or hard sessions.
5. **Injury & health history** — current niggles, past injuries, anything a plan must respect.
6. **Equipment & environment** — shoes/bike/devices, gym access, terrain and climate.
7. **Data sources** — which platform records completed workouts and wellness (or none); whether
   a fitness-data connector is available in their Claude account.
8. **Strength** — whether strength work is part of the plan (if not, delete the strength
   reference and section rows).

## Section skeleton (weave into `main`)

### Training — Snapshot

- **Primary sport:** [e.g. running]
- **Secondary sports:** [e.g. cycling, hiking — or none]
- **Training age:** [years]
- **Current weekly volume:** [hours or km]
- **Days available:** [e.g. Mon/Wed/Fri + weekend long session]
- **Season goal:** [one sentence, with target event + date]

### Training — Thresholds

Verify against current data before prescribing; update after tests or breakthrough performances.

| Metric                            | Value   | Last verified |
| --------------------------------- | ------- | ------------- |
| [Threshold pace / FTP / LTHR ...] | [value] | [date]        |

### Training — Personal Bests

| Event / distance | Result | Date | Notes |
| ---------------- | ------ | ---- | ----- |
| [..]             | [..]   | [..] | [..]  |

### Training — Framework

[The agreed methodology. Examples: polarized 80/20; Daniels-style quality sessions; sweet-spot
base for cycling. State:]

- Weekly structure: [e.g. 2 quality sessions + 1 long + easy filler]
- Intensity distribution target: [e.g. ~80% easy / ~20% moderate-hard]
- Progression rules: [e.g. volume +≤10%/week, down-week every 4th]
- Non-negotiables: [e.g. rest day after long run; no hard sessions on <6h sleep]

### Training — Zone Target Rules (strong defaults)

- Prescribe by [pace / power / heart rate / RPE] as primary target; details in `zones` reference.
- Easy means easy: [definition, e.g. "conversational, below X"].
- [Sport-specific rules from the interview.]

### Training — Workout Construction (strong defaults)

- Warm-up and cool-down conventions: [defaults].
- Interval session shape: [defaults, e.g. "state work duration, target, recovery explicitly"].
- Formatting conventions for pushing workouts to devices/platforms: see
  `workout-construction` reference.

### Training — Strength

[Delete if not applicable.]

- Purpose: [e.g. injury prevention, durability, performance]
- Frequency & placement in the week: [..]
- Current block: [..]
- Exercise library, session templates and periodization: see `strength` reference.

### Training — Season Roadmap

- **A goal:** [event, date]
- **B/C events:** [..]
- Phase structure and checkpoints: see `season-plan` reference.

## Reference files this pack adds

| Reference              | Content                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `zones`                | Full zone tables and threshold references                      |
| `strength`             | Strength evidence base, exercise library, session templates    |
| `workout-construction` | Workout formatting rules and platform syntax                   |
| `injuries`             | Active issues, triggers to watch, return-to-training protocols |
| `season-plan`          | Current season/campaign plan in full                           |
| `fitness-history`      | Long-term fitness and volume trajectory                        |
| `equipment`            | Gear, devices, terrain context                                 |
