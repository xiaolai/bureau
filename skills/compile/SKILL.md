---
name: compile
description: Distil logbook entries into consistency-checked cabinet pages — the canonical SSOT — writing provenance links back to the sessions that introduced each claim. Use when running bureau:compile, or when the user asks to turn the logbook into canon / update the cabinets / build the knowledge base from sessions.
argument-hint: "[--since <YYYY-MM-DD>] [--workspace <name>]"
---

# Compile — logbook → cabinet pages (the canon)

Read the append-only logbook and distil its claims into **cabinet pages**: the canonical,
consistency-checked SSOT a human inspects. Each cabinet claim carries a provenance link back
to the logbook entry that introduced it, so the canon is traceable and regenerable.

The logbook is faithful but low-authority and chronological; the cabinets are authoritative
and topical. Compile is the bridge — it consolidates many sessions into one current truth.

## Inputs

- The workspace (discover a `bureau.json`; default `bureau`).
- The set of logbook entries to process: every entry under `logbook/` whose session id is not
  yet recorded in `<workspace>/_compile-state.json`, narrowed by `--since <YYYY-MM-DD>` when
  given. `_compile-state.json` is the watermark: `{ "compiled": ["<session-id>", …] }`. It is
  underscore-prefixed, so whiteboard never renders it.

## Cabinet page schema

A cabinet page is one markdown file in a topic drawer (`decisions/`, `architecture/`,
`characters/`, …). Frontmatter uses whiteboard's simple parser, so titles are **unquoted** and
no value contains `"`, a newline, or `[ ] |`. Provenance lives in the **body** (a `Sources`
line), because whiteboard's backlinks panel indexes body links — not frontmatter lists:

```markdown
---
title: SSOT model
updated: 2026-06-10
status: canonical
---

# SSOT model

The wiki is authoritative for current truth; the logbook is low-authority provenance.
See [[Logbook model]].

**Sources.** [[session a1b2c3d4 · 2026-06-10]]
```

- `status`: `canonical` (settled), `draft` (provisional), or `contested` (an unresolved
  conflict — see the conflict policy).
- The body `**Sources.**` line wiki-links the logbook entries that justify this page, each by
  its title (`session <id8> · <date>`). This is the provenance — whiteboard renders it as a
  backlink, so each session shows which cabinet pages it produced, and the page lists the
  sessions that justify it. A claim that disagrees keeps its own inline `[[session …]]` link.

## Steps

1. **Locate the workspace** (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Select entries.** List logbook entries not in `_compile-state.json` (apply `--since`).
   If none remain, report "cabinets already current" and stop.
3. **Extract claims.** For each selected entry, read its Decisions and Changes. Each yields a
   claim and the cabinet page it belongs to (the entry names the target page).
4. **Place each claim.** Find the target cabinet page by title; if absent, create it in the
   drawer that matches its topic (use the profiles in `bureau.json` to pick the drawer). Write
   or update the claim in the page body.
5. **Write provenance.** Add the source logbook entry to the page's body `**Sources.**` line
   (a `[[session …]]` link). Never drop an existing source. Set `updated:` to today.
6. **Apply the conflict policy** (below) whenever a new claim disagrees with a page's current
   canonical claim.
7. **Mark compiled.** Append each processed session id to `_compile-state.json`.
8. **Structural check.** Run `bureau:inspect` (whiteboard build + health). Report the page
   count and any dangling links, orphans, or contradictions it surfaces.
9. **Report.** List pages created, pages updated, and any pages set to `contested`, with the
   command to inspect them.

## Conflict policy

A new claim that disagrees with a page's existing `canonical` claim is **never silently
overwritten**. Instead:

- set the page `status: contested`;
- keep both claims in the body, each with its own `[[session …]]` provenance;
- add a `contradicts:` frontmatter edge to the page the conflict relates to (whiteboard's
  health lane renders this as a contradiction finding);
- name the conflict in the report so the human resolves it.

Resolution is a human act: once the user picks the true claim, the page returns to
`canonical` with the losing claim removed (its provenance stays in the logbook).

## Rules

1. **Cabinets only.** Compile writes cabinet pages and `_compile-state.json`. It never edits
   logbook entries — the logbook is append-only history.
2. **Provenance is mandatory.** Every claim added to a cabinet traces to a `[[session …]]`
   source in the page body. No orphan claims.
3. **No silent overwrite.** Disagreement triggers the conflict policy, never a quiet replace.
4. **Idempotent.** Re-running skips already-compiled sessions; the same logbook yields the
   same cabinets.

## Scope note

This skill covers ONLY distillation: logbook entries → cabinet pages with provenance. It does
**not** capture sessions (that is the `capture` skill / `bureau:file-session`), does **not**
render the board (that is `bureau:inspect`), and does **not** run the semantic consistency
sweep (that is `bureau:lint`, planned). It is invoked by the `bureau:compile` command.
