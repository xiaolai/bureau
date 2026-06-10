---
name: lint
description: Sweep the cabinet pages for semantic inconsistencies that whiteboard's structural check cannot see — free-text contradictions, superseded claims, undocumented gaps, and vocabulary drift. Use when running bureau:lint, before a milestone, or when the user asks to check the canon for contradictions / consistency / drift.
argument-hint: "[--apply] [--workspace <name>]"
---

# Lint — semantic consistency of the canon

whiteboard's health lane is mechanical: it catches dangling links, orphans, stale dates, and
*typed* `contradicts:` edges. It cannot read prose. Lint is the judgment layer — an LLM sweep
that reads the cabinet pages and finds the inconsistencies that survive a structural check.

Run it on a cadence or before a milestone, **not** on every edit — it costs tokens and time.
It is the right-hand column of the consistency table: judgment, not mechanism.

## What it finds

1. **Contradiction** — two cabinet pages assert claims that cannot both be true (e.g. page A
   says auth tokens last 24h, page B says 1h).
2. **Superseded** — a page's settled (`verified`/`canonical`) claim is obsoleted by a newer
   cabinet page on the same topic; the canon still states the old truth. (Lint reads the
   cabinets, not the logbook — superseded evidence is cabinet-vs-cabinet.)
3. **Gap** — a concept referenced across pages but never defined on its own page.
4. **Drift** — one concept named differently across pages (vocabulary drift: "cabinet" vs
   "drawer" vs "page" for the same thing).

## Rigor — verify before recording (the audit→fix→verify discipline)

A false contradiction is worse than a missed one — it erodes trust in the canon. So every
candidate finding is **adversarially verified before it is recorded**:

1. **Find.** Read the corpus (chunk by drawer for a large workspace; fan out one reader per
   drawer when subagents are available). Collect candidate findings of each type.
2. **Refute.** For each candidate, try to disprove it — are the two claims actually about the
   same scope/time/entity, or is the conflict only apparent (different context, superseded
   already, profile-specific)? Default to discarding a candidate the refutation survives.
3. **Record only survivors.** A finding is written only if the refutation fails.

This mirrors `cc-suite:audit-fix`: dimensions → find → adversarially verify → report.

## Profile lenses

Load `bureau.json.profiles` and weight the sweep:
- **software** → decision reversals, API/behavior claims, version/config values.
- **story** → canon facts, timeline order, character traits and relationships.

## Output

Lint writes one rendered findings page: `<workspace>/lint/findings.md` (title **Lint
findings**, the `lint/` drawer renders as its own board section). It is overwritten each run —
it states the CURRENT findings, not history (history lives in the logbook). Each finding lists
its type, severity, the involved `[[pages]]` (body links, so they show as backlinks), and a
one-line suggested resolution.

With `--apply`, lint also writes conservative, reversible in-place markers so whiteboard's
health lane surfaces the hard cases:
- a verified **contradiction** → set both pages `status: contested` and add a reciprocal
  single-line `contradicts: [[Other page]]` edge to each (2+ pages → one comma list
  `contradicts: [[A]], [[B]]`, deduped, preserving any existing edge; never a multi-line YAML
  list, which whiteboard ignores). whiteboard renders the contradiction;
- a verified **superseded** claim → set the page `status: stale`.
Gaps and drift are report-only (creating pages or renaming a concept is a human/`compile`
decision, never an automatic edit).

## Steps

1. **Locate the workspace** (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Read the cabinets.** Load every cabinet drawer, EXCLUDING `logbook/`, the rendered
   `board/`, `lint/` (lint's own findings — never lint the findings), and every
   `_`-prefixed file/dir (state ledgers, not canon). If there are no cabinet pages yet, report
   "no cabinets to lint" and stop.
3. **Find + refute.** Run the find→refute→record loop above for all four finding types,
   weighted by the active profiles.
4. **Write the report.** Write `lint/findings.md` with the surviving findings; if none survive,
   write a page stating the canon is consistent.
5. **Apply markers** (only when `--apply`): set `contested`/`stale` status and `contradicts:`
   edges for verified contradictions and superseded claims. Never edit a page's prose claims —
   only its status and the contradicts edge.
6. **Structural check.** Run `bureau:inspect`; report the contradictions whiteboard now renders
   alongside the lint report.
7. **Report.** Summarize counts by type and severity, name each `contested` page, and point the
   user at `lint/findings.md`.

## Rules

1. **Read-mostly.** Without `--apply`, lint writes only the report page; it never edits the
   canon's claims.
2. **No prose edits.** Even with `--apply`, lint changes only `status:` and `contradicts:` —
   resolving a claim is a human act.
3. **Verified findings only.** A recorded finding survived adversarial refutation.
4. **Idempotent report.** Re-running overwrites `lint/findings.md` with the current state.

## Examples

<example>
Context: Before a milestone, the user wants the canon checked for inconsistencies.
user: "bureau:lint"
assistant: "Swept the cabinets. One survivor after refutation: **Token TTL** says 24h, **Session TTL** says 1h — a real contradiction (same artifact, same scope). I wrote it to lint/findings.md with both pages linked. The 'cabinet' vs 'drawer' wording I considered drift was refuted — they name different things — so I did not record it."
<commentary>Only findings that survive adversarial refutation are recorded; a false finding would erode trust in the canon.</commentary>
</example>

<example>
Context: The user wants lint to also mark the hard cases so the board surfaces them.
user: "bureau:lint --apply"
assistant: "Same findings, plus markers: I set both TTL pages to status: contested with reciprocal contradicts: edges, so whiteboard's health lane now reports the contradiction. I changed only status and edges — never the prose claims; resolving which TTL is true is your call."
<commentary>--apply writes conservative, reversible markers only; prose claims are never edited.</commentary>
</example>

## Scope note

This skill covers ONLY the semantic-consistency sweep of cabinet pages. It does **not** capture
sessions (`capture` / `bureau:file-session`), does **not** distil the logbook into cabinets
(`compile` / `bureau:compile`), and does **not** render the board (`bureau:inspect`). It reads
the cabinets that `compile` produced and is invoked by the `bureau:lint` command.
