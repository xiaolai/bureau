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
| `bureau:compile` | distil logbook entries into cabinet pages — _planned (Phase 2)_ |
| `bureau:lint` | semantic consistency sweep across cabinets — _planned (Phase 3)_ |
| `bureau:inspect` | build + open the board (whiteboard) |
