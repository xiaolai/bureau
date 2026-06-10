---
title: Overview
updated: {{DATE}}
---

# Overview

This is a **bureau** workspace — the durable canon distilled from your AI sessions.

- **Cabinets** are the canonical drawers (this folder's siblings: `decisions/`, and
  whatever topic drawers you add — `architecture/`, `characters/`, `timeline/`, …).
  They are the SSOT: *what is true now*. Co-authored by you and the LLM, consistency-checked.
- **[[Logbook]]** is the append-only history: *how we know / when it entered*. Low
  authority, faithful record. One entry per session.

Every cabinet claim links back to the logbook entry that introduced it, so the canon is
traceable and regenerable in principle.

## Workflow

| Command | Does |
|---------|------|
| `bureau:file-session` | write the rich logbook entry for the current session |
| `bureau:compile` | distil logbook entries into cabinet pages (with provenance) |
| `bureau:review` | the human gate — promote vetted claims to `canonical`, reject the rest |
| `bureau:lint` | semantic consistency sweep across cabinets (contradictions, gaps, drift) |
| `bureau:inspect` | build + open the board (whiteboard) |

## Reading this as memory — honor the trust tier

These cabinets double as repo memory, so **no claim is trusted as fact until a human has
approved it**. Every page carries a `status:`; honor it on every recalled claim:

| `status:` | trust | treat as |
|-----------|-------|----------|
| `canonical` | human-approved | **fact** |
| `verified` | checked against the repo, not yet approved | checked, confirm if it matters |
| `proposed` | AI claim, unchecked | **unverified — verify before relying** |
| `stale` | a verified source changed | outdated — re-verify |
| `contested` | two claims disagree | disputed — do not rely |

AI writes only `proposed`/`verified`; only `bureau:review` writes `canonical`. Never treat a
`proposed`, `stale`, or `contested` claim as fact.
