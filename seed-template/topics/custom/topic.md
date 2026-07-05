# Custom Topic

A meta-pack for coaching any life topic the shipped packs don't cover — sleep, stress, career,
learning, finances-adjacent habits, a hobby, anything the person wants recurring support on.
Instead of skeletons to copy, this pack is an interview for **defining** the topic together.

> **Instantiation instructions to the coaching assistant:** run the interview below, then build
> the topic from the answers: create the references you agreed on via `update_reference`, weave
> a topic section into `main` (under "Topic sections") using the shape sketched at the bottom,
> record the topic + goal in the snapshot's Active-topics table, and add any reference rows to
> the reference table. Design any routine with the `routine-design` reference.

## Interview — defining the topic

1. **Name & scope** — what should this topic be called, and what is explicitly in and out of
   scope? (A crisp boundary keeps coaching focused.)
2. **Goal & timeframe (WOOP)** — the wish in their words; what reaching it looks like
   (outcome); the biggest obstacle they expect; the if-then plan for that obstacle. Set a
   timeframe with a review point — no open-ended goals.
3. **Success signals** — how progress will be observed: what gets self-monitored, how often,
   and where it's recorded (usually the journal; keep logging easy — consistency beats
   completeness).
4. **Current state** — where things stand today; what has been tried; what worked and what
   didn't.
5. **Approach & rules** — the strategy you agree on, plus 2–4 strong-default rules the coach
   should hold them to (and when the coach may push back).
6. **Safety boundaries** — anything in this topic that touches medical, psychological,
   financial, or legal ground where the coach supports but professionals decide. Record the
   boundary explicitly; refer out when it's reached.
7. **References to create** — typically a `[topic]-profile` (current state + rules) and, if the
   topic accumulates material, a `[topic]-log` or collection reference. Only create what will
   actually be maintained.
8. **Routine?** — would a scheduled check-in help (weekly is the default)? If yes, design it
   per `routine-design` and store it via `save_routine`.

## Section shape (adapt, don't copy blindly)

### [Topic name]

- **Goal:** [WOOP-framed goal + timeframe + review point]
- **Success signals:** [what is tracked, how often]
- **Approach:** [the agreed strategy]
- **Strong defaults:** [2–4 rules, incl. when the coach pushes back]
- **Boundaries:** [where professionals take over]
- Detail: see `[topic]-profile` reference [if created].
