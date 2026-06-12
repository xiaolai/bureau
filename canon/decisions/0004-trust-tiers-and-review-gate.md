---
title: Trust tiers and the review gate
updated: 2026-06-11
status: proposed
---

# Trust tiers and the review gate

Memory works like version control, not a notepad the AI scribbles in. Every cabinet page
carries a `status:`:

- `proposed` — AI claim, unchecked.
- `verified` — auto-checked against the repo, not yet approved.
- `canonical` — a human approved it → **fact** (only `bureau:review` writes this).
- `stale` — a verified source changed / a claim was superseded.
- `contested` — two claims disagree.

AI writes only `proposed`/`verified` (+ `contested`/`stale` as findings); the
`proposed → review → canonical` gate is the double-check. The **`BUREAU.md`** instructions `init`
writes (imported by `CLAUDE.md`) make every AI session honor the tiers on read, so the gate
governs all work — not just bureau commands.

_This page is `proposed`: it states the design intent and awaits human review via
`bureau:review` to become canonical._

**Sources.** [[session architecture · 2026-06-11]]
