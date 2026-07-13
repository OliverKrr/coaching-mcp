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
