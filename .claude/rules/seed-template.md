---
paths:
  - "seed-template/**"
---

# Seed template

`seed-template/` is product content for end users: it ships in the npm package and is baked into
the Docker image as `/seed`. Write it for the coaching assistant and the user, not for developers.

A change onboarded users should receive gets an entry in `seed-template/UPDATES.md` in the same
commit. Seeding runs once per user (`seedFromDirectory()` returns early once `sections` has a row),
so the ledger is the only path a template change has to existing users. The entry format is
described at the top of `UPDATES.md`; ids are monotonic integers, and a new user's watermark is
stamped to the latest id at seed time.

`topics/**` is never auto-seeded. `get_topic_pack` delivers it and the assistant instantiates it
through the normal write tools, so a pack change reaches only users who install the pack later
unless it also gets a ledger entry.

Why it works this way: `docs/design-decisions.md`, sections "Seed updates propagate
agent-mediated" and "Topic packs are read-only content".
