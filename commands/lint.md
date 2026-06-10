---
description: Sweep the cabinets for semantic inconsistencies (contradictions, superseded claims, gaps, drift) and write a findings report.
argument-hint: "[--apply] [--workspace <name>]"
---

# bureau:lint

Check the canon for the inconsistencies whiteboard's structural health check cannot see —
free-text contradictions between pages, claims a newer cabinet page superseded, undocumented gaps,
and vocabulary drift. Run it on a cadence or before a milestone, not on every edit.

Follow the protocol in the **lint** skill (`skills/lint/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. Read every cabinet drawer, EXCLUDING `logbook/`, `board/`, `lint/` (its own findings), and
   every `_`-prefixed file/dir. If there are no cabinet pages, report "no cabinets to lint" and
   stop.
3. For each finding type — contradiction, superseded (cabinet-vs-cabinet), gap, drift — find
   candidates, then adversarially refute each one and keep only the survivors (a false finding
   erodes trust). Weight the sweep by the active `bureau.json` profiles.
4. Write `lint/findings.md` (the rendered report): each finding's type, severity, involved
   `[[pages]]`, and a suggested resolution. If none survive, state the canon is consistent.
5. With `--apply`, also set verified contradictions to `status: contested` with a reciprocal
   single-line `contradicts: [[Other page]]` edge (a comma list for 2+ items, deduped, preserving
   existing; never a YAML list), and superseded claims to `status: stale` — status and edges
   only, never prose. Then run `bureau:inspect` for the structural check.
6. Report counts by type and severity, name each contested page, and point at `lint/findings.md`.
