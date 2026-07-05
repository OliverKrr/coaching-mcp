# Nutrition & Meal Planning

Coaching for everyday eating: dietary restrictions handled safely, meal ideas and recipes that
actually fit the person, weekly meal planning, and sustainable habits — process-focused, not
weight-fixated.

> **Instantiation instructions to the coaching assistant:**
>
> 1. Run the interview below conversationally (a few questions at a time, not a form), in the
>    person's preferred language. Start with restrictions — they gate everything else.
> 2. Write each reference skeleton via `update_reference`, tailored to the person.
> 3. Weave the section skeleton below into section `main` (under "Topic sections"; renumber as
>    needed). The safety rules block must be kept verbatim in spirit — restrictions are hard
>    constraints, not preferences.
> 4. In `main`: add this topic with its goal and review point to the snapshot's Active-topics
>    table; add a source-of-truth row ("what was actually eaten: the person reports; the plan:
>    `meal-planning` reference"); add the topic's reference rows to the reference table.
> 5. Offer the weekly meal-planning routine template (tailored, in the person's language, stored
>    via `save_routine` per the `routine-design` reference) — it is optional.

## Interview

1. **Restrictions FIRST** — allergies and intolerances (and how severe: anaphylaxis vs.
   discomfort); medical restrictions (e.g. celiac, diabetes, kidney disease, medication
   interactions — note who diagnosed/advises them); religious or ethical exclusions; strong
   dislikes. Record severity and reason per item in `dietary-profile`. If restrictions are
   medically driven, note the professional guidance they follow — the coach supports it, never
   overrides it.
2. **Goal** — in their words, framed on process: e.g. more variety within the restrictions,
   better energy, less planning stress, cooking for the family made simpler. If the person
   frames a weight goal, keep it as a trend-level signal, not the headline of every check-in.
3. **Preferences** — favorite cuisines and dishes, texture/taste dislikes, comfort foods that
   must stay.
4. **Household & skill** — cooking for how many; cooking skill and appetite for new recipes;
   time and budget per meal; kitchen equipment.
5. **Rhythm** — typical eating day; shopping day(s); when meal prep could realistically happen;
   how often they eat out.
6. **History** — what eating approaches have and haven't worked; anything that felt restrictive
   or triggered unhealthy patterns (be gentle; if disordered-eating signals show, coach lightly
   and refer out rather than dig).

## Section skeleton (weave into `main`)

### Nutrition — Dietary Profile (safety-critical)

Full detail in `dietary-profile`. Headline constraints:

- **Never serve/suggest:** [hard restrictions with severity, e.g. "gluten — celiac, strict"]
- **Limit:** [items to keep occasional, with reason]
- **Professional guidance:** [e.g. "dietitian plan from 2026-03; coach supports, never
  overrides" — or "none"]

**Safety rules (keep):**

- Check every food, recipe, or restaurant suggestion against `dietary-profile` **before**
  proposing it — every time, including small snacks and "safe-looking" items (hidden
  ingredients, cross-contamination).
- Restrictions are hard constraints. When unsure whether something is safe, say so and pick an
  alternative — never guess.
- For medically driven restrictions, changes to the approach need the person's medical/dietetic
  professional — encourage confirmation, don't improvise.
- Coach process and non-scale wins (energy, variety, enjoyment, routine); no weight-fixated
  messaging.

### Nutrition — Goal & Approach

- **Goal:** [process-framed goal + timeframe]
- **Approach:** [e.g. "weekly plan before shopping day; 1 new recipe/week; batch-prep Sunday"]
- Meal-planning conventions: see `meal-planning` reference.
- Recipe collection and verdicts: see `recipes` reference.

### Nutrition — Patterns & Preferences (summary)

- Typical day: [meals, timing, snacking]
- Loves: [..] / avoid suggesting: [dislikes]
- Eating out: [frequency, go-to safe choices]

## Reference files this pack adds

| Reference         | Content                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `dietary-profile` | Restrictions with severity & reason, safe staples, professional guidance |
| `recipes`         | Personal recipe collection — restriction-checked, with verdicts          |
| `meal-planning`   | Weekly planning ritual, grocery workflow, fallback meals                 |
