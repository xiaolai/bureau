---
name: compile
description: Distil minutes into consistency-checked dossiers — the canonical SSOT — writing provenance links back to the sessions that introduced each claim. Use when running bureau:compile, or when the user asks to turn the logbook into canon / update the cabinets / build the knowledge base from sessions.
argument-hint: "[--since <YYYY-MM-DD>] [--workspace <name>]"
---

# Compile — logbook → dossiers (the canon)

Read the append-only logbook and distil its claims into **dossiers**: the canonical,
consistency-checked SSOT a human inspects. Each cabinet claim carries a provenance link back
to the minute that introduced it, so the canon is traceable and regenerable.

The logbook is faithful but low-authority and chronological; the cabinets are authoritative
and topical. Compile is the bridge — it consolidates many sessions into one current truth.

## Inputs

- The workspace (discover a `bureau.json`; default `bureau`).
- The set of minutes to process: every entry under `logbook/` whose session id is not
  yet recorded in `<workspace>/_compile-state.json`, narrowed by `--since <YYYY-MM-DD>` when
  given. `_compile-state.json` is the watermark: `{ "compiled": ["<session-id>", …] }`. It is
  underscore-prefixed, so the press never renders it.

## Cabinet page schema

A dossier is one markdown file in a topic drawer (`decisions/`, `architecture/`,
`characters/`, …) holding **one claim** (see step 4 — one claim per page keeps a page's trust
tier unambiguous). Frontmatter uses the press's simple parser: the **title is unique and
unquoted** and a scalar value contains no `"`, newline, or `[ ] |`. The only values that carry
`[[ ]]` are **relation edges** like `contradicts: [[Other page]]`. Frontmatter takes flat
`key: value` lines, inline lists (`tags: [a, b]`), and multi-line lists of scalars; values are
always strings (no YAML type coercion), and nested maps or block scalars are **rejected** — the
build fails. Provenance is a `[[wiki-link]]` to a minute: an edge the press indexes, so the minute
gets a backlink showing which dossiers it produced. A frontmatter `sources:` list of wiki-links
would index too, but **compile writes it in the body**, as a `Sources` line — one shape, easy to
review. `gazette health` reports any tiered page with no provenance link as **unsourced**:

```markdown
---
id: 01J9Z8QKQ7ULIDEXAMPLE
title: SSOT model
updated: 2026-06-10
status: proposed
rests_on:
  - { page: "[[Logbook model]]", span: "^authority", because: "the SSOT split assumes the logbook is low-authority" }
---

# SSOT model

The wiki is authoritative for current truth; the logbook is low-authority provenance. ^ssot-claim
See [[Logbook model]].

**Sources.** [[session a1b2c3d4 · 2026-06-10]]
```

- **`id`** is an opaque, immutable identifier — stamp one on **every** dossier (a ULID, or any
  unique token; e.g. `pg-<slug>-NNNN`). It is the page's identity, so a later rename never breaks a
  dependency that points at it. A page with no `id` falls back to a title-derived shim that *does*
  break on rename — so always author one.
- **The claim carries a `^span`** — a `^anchor` at the end of the claim line (`^ssot-claim` above).
  This is what a dependent page points at. Anchor exactly the sentence(s) another page could depend
  on; keep it stable so cosmetic edits elsewhere don't churn it.
- **`rests_on`** declares a dependency: when *this* dossier's claim relies on *another* dossier's
  claim, add an object edge naming the target `[[page]]`, its `^span`, and a `because`. The
  recursion engine then flags this page `needs-review` whenever that upstream span changes. These
  edges are **proposed** by compile and **confirmed by the human at review** — declare them
  generously (under-scoping is the silent killer; over-scoping only annoys). Omit `rests_on` for a
  standalone claim.
- `status` is the trust tier (defined in the `review` skill). Compile writes only `proposed`
  (an AI claim, unchecked) or `verified` (a fact it confirmed against the repo). It **never**
  writes `canonical` — that tier is reached only through `bureau:review`, the human gate. A
  conflict yields `contested` (see the conflict policy).
- The body `**Sources.**` line wiki-links the minutes that justify this page, each by
  its title (`session <session-id> · <date>`). This is the provenance — the press renders it as a
  backlink, so each session shows which dossiers it produced, and the page lists the
  sessions that justify it. A claim that disagrees keeps its own inline `[[session …]]` link.

## Steps

1. **Locate the workspace** (`bureau.json`; default `canon`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Select entries.** List minutes not in `<workspace>/_compile-state.json` (apply
   `--since`). If none remain, report "cabinets already current" and stop.
3. **Extract claims.** For each selected entry, read its Decisions and Changes. Each yields a
   claim and the dossier it belongs to (the entry names the target page).
4. **Place each claim — one claim per page.** Derive the page title; **enforce the title
   rules**: NFC-trim, strip any `[ ] |` and quotes, and if the title collides with an existing
   page on a *different* claim, disambiguate (append a qualifier) rather than overwrite. Find
   the page by title; if absent, create it in the drawer matching its topic (use the
   `bureau.json` profiles). Keep distinct claims on distinct pages so each page has a single,
   unambiguous trust tier.
5. **Stamp identity + anchor the claim (the recursion engine).** Ensure every page you touch —
   created OR updated — carries an opaque `id:` (mint one if absent; never change an existing one),
   and anchor its claim sentence with a `^span` (e.g. `^ssot-claim`). This makes the page
   rename-safe and gives dependents something stable to point at. A page you update that predates
   the engine (no `id`/`^span`) is **retrofitted here** — add both.
6. **Declare dependencies — propose `rests_on`.** For each page, ask: does its claim *rest on*
   another dossier's claim (it assumes it, builds on it, cites it as its basis)? If so, add a
   `rests_on` object edge naming that `[[page]]`, its `^span`, and a one-line `because`. Declare
   generously — a missing edge is silent staleness the gate can never catch; a spurious one only
   costs a review click. These are **proposals**; the human confirms them at `bureau:review`.
7. **Write provenance.** Add the source minute to the page's body `**Sources.**` line
   (a `[[session …]]` link). Never drop an existing source. Set `updated:` to today.
8. **Set the trust tier.** A claim about a checkable artifact (a path, a build command, a
   function signature, a config value, a dependency version, a commit) is confirmed against the
   live repo. **Before reading any path from a claim, resolve it and confirm it stays inside
   the repo/workspace** — reject absolute paths, `..` escapes, and symlinks that point outside;
   read only contained paths. If the claim holds, set `status: verified`, add a body
   `**Verified.**` line naming the artifact and date, and record the fingerprint by running the
   bundled press:
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" ledger verify --dir <workspace> --page "<title>" --artifact <repo-relative-path> --claim "<what>"`
   (it writes `<workspace>/_verify.json` in code — **never hand-edit it**; the schema below is for
   reference). Everything else — judgments, rationale, anything not mechanically checkable —
   stays `status: proposed`. Never write `canonical` (that is `bureau:review`).
9. **Apply the conflict policy** (below) whenever a new claim disagrees with a page's current
   claim.
10. **Scan + structural check.** First record the new/changed claim spans into the decision log so
    the gate can flag downstream drift:
    `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" scan --dir <workspace>`. Then run
    `bureau:inspect` (press build + health) and
    `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" gate --dir <workspace>`. Report the dossier
    count, any dangling/orphan/contradiction findings, AND any pages the gate now marks
    `needs-review` (they rested on a claim this compile changed) — those go to `bureau:review`.
11. **Mark compiled — only on success.** ONLY after the writes and the structural check succeed,
    record each processed session id by running
    `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" ledger mark-compiled <session-id> … --dir <workspace>`
    (it writes `<workspace>/_compile-state.json` in code, idempotently — **do not hand-edit it**). A
    failed inspect must leave the session un-compiled so the next run retries it, not skips broken output.
12. **Report.** List pages created, pages updated, `rests_on` edges proposed, pages left `proposed`
    (awaiting `bureau:review`), any set to `contested`, and any newly `needs-review`, with the
    command to inspect them.

### Retrofitting an existing canon (one-time)

A canon created before the engine has dossiers with no `id`, no `^span`, and no `rests_on`. To adopt
the engine, do a **one-time sweep** the first time you compile it (in addition to the per-minute work
above): for **every** existing dossier, stamp an opaque `id:` and anchor its claim with a `^span`;
then read the prose for dependencies the author already implied (a page that links `[[Other]]` and
*builds on* its claim `rests_on` it) and propose those edges with a `because`. Finish with a `scan`.
This is incremental and safe — nothing is promoted; the human confirms the proposed edges at
`bureau:review`. Declare edges generously: the sweep is your one chance to capture the dependency
structure the prose already encodes.

### `_verify.json` schema (code-owned)

Written by `gazette ledger verify` (press `engine/ledgers.mjs`), never by hand. Keyed by page
title, so `bureau:review` can map a fingerprint back to the page and re-check it
(`gazette ledger recheck --dir <workspace> --page "<title>"`):

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
  deduped — keep it single-line so the edge reads as one diff). Add the reciprocal edge
  on the other page. the press's health lane then renders the contradiction;
- name the conflict in the report so the human resolves it.

Resolution is a human act: once the user picks the true claim, the losing claim is removed
(its provenance stays in the logbook) and the page goes back through `bureau:review` to reach
`canonical`.

## Rules

1. **Cabinets only.** Compile writes dossiers and records the ledgers via the bundled press's
   `gazette ledger` command (the code owns `_compile-state.json` and `_verify.json` — do not
   hand-write them). It never edits minutes — the logbook is append-only history.
2. **Provenance is mandatory.** Every claim added to a cabinet traces to a `[[session …]]`
   source in the page body. No orphan claims.
3. **No silent overwrite.** Disagreement triggers the conflict policy, never a quiet replace.
4. **Idempotent.** Re-running skips already-compiled sessions; the same logbook yields the
   same cabinets.

## Examples

<example>
Context: Three sessions have been filed but the cabinets are out of date.
user: "bureau:compile"
assistant: "3 uncompiled sessions. I distilled their decisions into dossiers — created **Capture design** and **SSOT model** under decisions/, updated **Logbook model**, each with a body **Sources.** line linking the session that introduced it. The build command claim verified against package.json (status: verified); the design rationale stays proposed for bureau:review."
<commentary>Facts checkable against the repo become verified; judgments stay proposed for the human gate. Provenance is a body link so it shows as a backlink.</commentary>
</example>

<example>
Context: A new session asserts a token TTL that conflicts with an existing page.
user: "Update the cabinets from the latest session."
assistant: "The new claim (tokens last 1h) disagrees with **Token TTL** (24h). Per the conflict policy I did not overwrite — I set the page status: contested, kept both claims with their provenance, and added a contradicts: edge so the press's health flags it. Resolve it in a session, then recompile."
<commentary>Disagreement never silently overwrites — it surfaces as a contested page with a contradicts edge for the human.</commentary>
</example>

## Scope note

This skill covers ONLY distillation: minutes → dossiers with provenance. It does
**not** capture sessions (that is the `capture` skill / `bureau:file-session`), does **not**
render the gazette (that is `bureau:inspect`), and does **not** run the semantic consistency
sweep (that is `bureau:lint`). It is invoked by the `bureau:compile` command.
