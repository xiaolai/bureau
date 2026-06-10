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
  underscore-prefixed, so gazette never renders it.

## Cabinet page schema

A cabinet page is one markdown file in a topic drawer (`decisions/`, `architecture/`,
`characters/`, …) holding **one claim** (see step 4 — one claim per page keeps a page's trust
tier unambiguous). Frontmatter uses gazette's simple parser: the **title is unique and
unquoted** and a scalar value contains no `"`, newline, or `[ ] |`. The only values that carry
`[[ ]]` are **single-line typed relation edges** like `contradicts: [[Other page]]` (never a
multi-line YAML list — the simple parser ignores those). Provenance lives in the **body** (a
`Sources` line), because gazette's backlinks panel indexes body links, not frontmatter:

```markdown
---
title: SSOT model
updated: 2026-06-10
status: proposed
---

# SSOT model

The wiki is authoritative for current truth; the logbook is low-authority provenance.
See [[Logbook model]].

**Sources.** [[session a1b2c3d4 · 2026-06-10]]
```

- `status` is the trust tier (defined in the `review` skill). Compile writes only `proposed`
  (an AI claim, unchecked) or `verified` (a fact it confirmed against the repo). It **never**
  writes `canonical` — that tier is reached only through `bureau:review`, the human gate. A
  conflict yields `contested` (see the conflict policy).
- The body `**Sources.**` line wiki-links the logbook entries that justify this page, each by
  its title (`session <session-id> · <date>`). This is the provenance — gazette renders it as a
  backlink, so each session shows which cabinet pages it produced, and the page lists the
  sessions that justify it. A claim that disagrees keeps its own inline `[[session …]]` link.

## Steps

1. **Locate the workspace** (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Select entries.** List logbook entries not in `<workspace>/_compile-state.json` (apply
   `--since`). If none remain, report "cabinets already current" and stop.
3. **Extract claims.** For each selected entry, read its Decisions and Changes. Each yields a
   claim and the cabinet page it belongs to (the entry names the target page).
4. **Place each claim — one claim per page.** Derive the page title; **enforce the title
   rules**: NFC-trim, strip any `[ ] |` and quotes, and if the title collides with an existing
   page on a *different* claim, disambiguate (append a qualifier) rather than overwrite. Find
   the page by title; if absent, create it in the drawer matching its topic (use the
   `bureau.json` profiles). Keep distinct claims on distinct pages so each page has a single,
   unambiguous trust tier.
5. **Write provenance.** Add the source logbook entry to the page's body `**Sources.**` line
   (a `[[session …]]` link). Never drop an existing source. Set `updated:` to today.
6. **Set the trust tier.** A claim about a checkable artifact (a path, a build command, a
   function signature, a config value, a dependency version, a commit) is confirmed against the
   live repo. **Before reading any path from a claim, resolve it and confirm it stays inside
   the repo/workspace** — reject absolute paths, `..` escapes, and symlinks that point outside;
   read only contained paths. If the claim holds, set `status: verified`, add a body
   `**Verified.**` line naming the artifact and date, and record an entry in
   `<workspace>/_verify.json` (schema below). Everything else — judgments, rationale, anything
   not mechanically checkable — stays `status: proposed`. Never write `canonical` (that is
   `bureau:review`).
7. **Apply the conflict policy** (below) whenever a new claim disagrees with a page's current
   claim.
8. **Structural check.** Run `bureau:inspect` (gazette build + health). Report the page
   count and any dangling links, orphans, or contradictions it surfaces.
9. **Mark compiled — only on success.** ONLY after the writes and the structural check succeed,
   append each processed session id to `<workspace>/_compile-state.json`. A failed inspect must
   leave the session un-compiled so the next run retries it, not skips broken output.
10. **Report.** List pages created, pages updated, pages left `proposed` (awaiting
    `bureau:review`), and any set to `contested`, with the command to inspect them.

### `_verify.json` schema

Keyed by page title, so `bureau:review` can map a fingerprint back to the page and re-check it:

```json
{
  "<page title>": {
    "verifiedAt": "<YYYY-MM-DD>",
    "checks": [
      { "artifact": "<repo-relative path>", "hash": "<sha256>", "claim": "<what was confirmed>" }
    ]
  }
}
```

## Conflict policy

A new claim that disagrees with a page's existing claim is **never silently overwritten**.
Instead:

- set the page `status: contested`;
- keep both claims in the body, each with its own `[[session …]]` provenance;
- add a typed `contradicts:` edge naming the other page — a **single line**:
  `contradicts: [[Other page]]` (for 2+, one comma list `contradicts: [[A]], [[B]]`,
  deduped; **never** a multi-line YAML list, which gazette ignores). Add the reciprocal edge
  on the other page. gazette's health lane then renders the contradiction;
- name the conflict in the report so the human resolves it.

Resolution is a human act: once the user picks the true claim, the losing claim is removed
(its provenance stays in the logbook) and the page goes back through `bureau:review` to reach
`canonical`.

## Rules

1. **Cabinets only.** Compile writes cabinet pages, `_compile-state.json`, and `_verify.json`.
   It never edits logbook entries — the logbook is append-only history.
2. **Provenance is mandatory.** Every claim added to a cabinet traces to a `[[session …]]`
   source in the page body. No orphan claims.
3. **No silent overwrite.** Disagreement triggers the conflict policy, never a quiet replace.
4. **Idempotent.** Re-running skips already-compiled sessions; the same logbook yields the
   same cabinets.

## Examples

<example>
Context: Three sessions have been filed but the cabinets are out of date.
user: "bureau:compile"
assistant: "3 uncompiled sessions. I distilled their decisions into cabinet pages — created **Capture design** and **SSOT model** under decisions/, updated **Logbook model**, each with a body **Sources.** line linking the session that introduced it. The build command claim verified against package.json (status: verified); the design rationale stays proposed for bureau:review."
<commentary>Facts checkable against the repo become verified; judgments stay proposed for the human gate. Provenance is a body link so it shows as a backlink.</commentary>
</example>

<example>
Context: A new session asserts a token TTL that conflicts with an existing page.
user: "Update the cabinets from the latest session."
assistant: "The new claim (tokens last 1h) disagrees with **Token TTL** (24h). Per the conflict policy I did not overwrite — I set the page status: contested, kept both claims with their provenance, and added a contradicts: edge so gazette's health flags it. Resolve it in a session, then recompile."
<commentary>Disagreement never silently overwrites — it surfaces as a contested page with a contradicts edge for the human.</commentary>
</example>

## Scope note

This skill covers ONLY distillation: logbook entries → cabinet pages with provenance. It does
**not** capture sessions (that is the `capture` skill / `bureau:file-session`), does **not**
render the board (that is `bureau:inspect`), and does **not** run the semantic consistency
sweep (that is `bureau:lint`). It is invoked by the `bureau:compile` command.
