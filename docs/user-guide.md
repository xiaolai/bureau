# bureau — User Guide

This guide is for the person *driving* bureau. (The other audience — any AI session working in
your repo — is governed automatically by `BUREAU.md`, the instructions `bureau:init` writes at
your repo root and wires into `CLAUDE.md`; you don't manage that.)

The one idea to hold onto: **bureau treats every AI session like a meeting, and your knowledge
like version control.** Sessions are minuted (the *logbook*), distilled into a canon (the
*cabinets*), and **no claim is trusted as fact until you approve it.**

---

## Quickstart (60 seconds)

```bash
claude plugin install bureau@xiaolai      # self-contained; nothing else to install
```

In your project, once:

```
/bureau:init
```

That scaffolds a `canon/` workspace (your cabinet drawers + a `logbook/`), writes `BUREAU.md`
(imported by `CLAUDE.md`), and gitignores the rendered gazette. Then the loop:

```
… work a normal AI session …
/bureau:note          # at each real decision — jots a live minute
/bureau:file-session  # at the end — files the full entry
/bureau:compile       # distil the new sessions into dossiers
/bureau:review        # approve the vetted claims → canonical (the double-check)
/bureau:query "…"     # ask the canon anything, later
/bureau:inspect       # open the gazette to read it as a human
```

You don't need all of them every time — see *What to run when* below.

---

## A worked example

You spend a session deciding your auth token lifetime.

1. **Mid-session, a decision lands.** `/bureau:note` →
   appends to `canon/logbook/2026/06/<session>.md`:
   > checkpoint 14:30 — decided: auth tokens last 24h (security review). open: refresh-token TTL.

2. **End of session.** `/bureau:file-session` finalizes that entry — intent, decisions, changed
   files, open threads — append-only history. (If you forget, a `SessionEnd` hook still saves a
   stub, and a compaction mid-session re-grounds the agent from the logbook.)

3. **Distil to canon.** `/bureau:compile` reads the new minute and writes a dossier:
   ```
   canon/decisions/token-ttl.md   →  title: Token TTL   status: proposed
       "Auth tokens last 24h."   **Sources.** [[session a1b2 · 2026-06-10]]
   ```
   It's `proposed` — an AI claim, **not yet fact**. A checkable fact (a path, a command) compile
   may mark `verified` after confirming it against the repo; a judgment stays `proposed`.

4. **Your double-check.** `/bureau:review` shows the pending claim with its provenance. You
   approve → `status: canonical`. *Now* it's fact. (Reject → it's removed and the rejection is
   logged; the logbook history is never rewritten.)

5. **Use it, later.** `/bureau:query "how long do auth tokens last?"` →
   > Auth tokens last 24h. *[Token TTL, canonical]*
   If it were still `proposed`, query would say so and refuse to state it as fact.

---

## What to run when

| Moment | Run | Why |
|--------|-----|-----|
| A decision is made mid-session | `bureau:note` | live minute — higher fidelity than reconstructing at the end |
| End of a working session | `bureau:file-session` | file the full structured entry |
| After one or more filed sessions | `bureau:compile` | turn minutes into dossiers |
| You have a few minutes to vet memory | `bureau:review` | promote vetted claims to `canonical` |
| Before a milestone / periodically | `bureau:lint` | catch contradictions, gaps, drift across the canon |
| You need to recall something | `bureau:query "…"` | tier-aware answer with citations |
| "What needs my attention?" | `bureau:status` | uncompiled · pending-review · **needs-review/stale (the gate)** · contested · the convergence verdict |
| "Is the canon settling or churning?" | `gazette telemetry` | the convergence trend — queue depth/age, repeated firings, `drained`/`stabilizing`/`thrashing` |
| Bring the whole canon up to date | `bureau:cycle` | one pass: compile → scan → lint → review → inspect |
| Read it as a human | `bureau:inspect` | build + open the offline gazette |
| Watch freshness update as you edit | `bureau:serve` | the live board — dependents light up on change |
| Pin / diff / view a past version | `bureau:snapshot` | git-backed snapshots, diffs, and historical boards |

Capture is cheap and frequent; review is the deliberate, valuable step. You can let proposed
claims pile up and review them in a batch. `bureau:cycle` runs the whole loop for you.

---

## Reading the canon — the trust tiers

Every dossier carries a `status:`. It travels with the claim, so an unverified one can
never pass as fact:

| `status:` | meaning | trust |
|-----------|---------|-------|
| `canonical` | a human (you) approved it | **fact** |
| `verified` | auto-checked against the repo, not yet approved | checked — reconfirm if load-bearing |
| `proposed` | an AI claim, unchecked | **not fact** — verify before relying |
| `stale` | a verified source changed since the check | outdated — re-verify |
| `contested` | two claims disagree | disputed — resolve before relying |

`bureau:query` enforces this for you. And because `init` wrote `BUREAU.md` and made `CLAUDE.md`
import it, *any* AI session in the repo is told to honor these tiers when it reads the cabinets as
memory and to route new claims through capture → compile → review — never straight to canon.

---

## Keeping the canon fresh — dependency tracking

Trust is one axis; **freshness** is a second, independent one. A dossier can *declare* that its claim
**rests on** another dossier's claim, and bureau's recursion engine keeps that honest: when the
upstream claim changes, the downstream dossier drops out of `current` and is flagged **needs-review**
— even if a human had already approved it (`canonical`). A page that sits on a changed upstream is
not current fact until re-reviewed.

You don't have to wire this by hand: **`bureau:compile` stamps the `id`, anchors each claim with a
`^span`, and proposes the `rests_on` edges** as it distils minutes into dossiers, and **`bureau:review`
is where you confirm them.** (An older canon is retrofitted the same way on its first engine-aware
compile.) A dossier ends up looking like this:

```yaml
---
id: 01J9ZB…                         # opaque, immutable — a rename never breaks the link
title: Query design
rests_on:
  - { page: "[[SSOT model]]", span: "^ssot-claim", because: "the query layer assumes the wiki is authoritative" }
---
# Query design
Answers come only from the compiled canon, never a raw file. ^query-claim
```

Then the loop is: edit a claim → `gazette scan` records the change → the gate flags whatever rested on
it → `bureau:review` (or `bureau:cycle`) surfaces it → you confirm it still holds (or fix it). A
**cosmetic** edit outside a cited claim propagates to nobody. `bureau:status` and the live board
(`bureau:serve`) show the current needs-review/stale set at a glance.

Freshness is page↔page. There's a second axis — **claim↔file**: bureau can fingerprint the real file a
claim was checked against (`gazette ledger verify --artifact <path>`), and the gazette's **Engine view**
(on the Health page) then flags it **DRIFTED** the moment that file changes — so a `canonical` claim
whose code moved out from under it can't quietly stay green. The Engine view gathers all three live
signals in one place: freshness, artifact currency, and the convergence trend.

This is the flagship feature — the full model, the four-field state, and the honest limits are in
**[The recursion engine](recursion-engine.md)**.

---

## Rich content in a dossier

A dossier is markdown, but the press hydrates a few fenced blocks into interactive widgets in the
gazette (they degrade gracefully when JavaScript is off):

- **Tabbed sections** — a ` ```tabs ` fence with `=== Title` markers per panel; each panel body is
  ordinary markdown (wiki-links, tables, code all work):

  ````
  ```tabs
  === Overview
  The short version, with a [[Link]] and **emphasis**.
  === Details
  | col | col |
  |-----|-----|
  | a   | b   |
  ```
  ````

- **Charts & tables** — ` ```viz ` / ` ```chart ` / ` ```table ` / ` ```graph ` fences over CSV / JSON
  / YAML data. **Diagrams** — a ` ```mermaid ` fence.

Authoring stays in markdown; the press owns the rendering, so content stays themed, sanitized, and
consistent. Run `bureau:serve --watch` to rebuild the gazette as you edit.

---

## Maintenance

- **`bureau:status`** is your dashboard: how many sessions are uncompiled, how many dossiers await
  review, what's stale or contested. It tells you the one or two next actions.
- **`bureau:lint`** sweeps for semantic problems the structural check can't see (contradictions
  between dossiers, superseded claims, gaps, vocabulary drift). Run it before a milestone. With
  `--apply` it marks the hard cases (`contested`/`stale`) so the gazette surfaces them.
- **Contested dossiers** are resolved by *re-deciding* in a session (then recompile + review), not
  by editing the canon directly.
- **Stale dossiers** mean a source the claim depended on changed — re-verify and re-approve.

---

## Crew — specialized agents that work the canon

A **desk** is a focused agent (plus an always-on one-paragraph brief) that operates on your
canon. `bureau:crew` manages them:

- **`bureau:crew`** lists what's enabled and what's available.
- **`bureau:crew enable auditor`** turns on a member bureau ships. The **Auditor** is a *read-only*
  reviewer — point it at the canon to hunt contradictions, stale claims, schema violations, and
  `canonical`/`verified` pages that aren't actually supported. It reports; it never edits.
- **`bureau:crew new <name> --role "…"`** scaffolds *your own* member, then you flesh out its
  persona. It's a real Claude Code subagent — invocable as `<name>`.

Each member is authored under `bureau/crew/<name>/` (committed — your source of truth) and
*materialized* into Claude Code's native slots (`.claude/agents/`, `.claude/skills/`); the brief
loads every session via an `@import` in `BUREAU.md`. The generated files under `.claude/` carry a
`bureau:gen` marker — never hand-edit them; edit the source and run **`bureau:crew sync`**.
**`bureau:crew check`** verifies everything is in sync (and `bureau:init` re-materializes on a fresh
clone). Commit `bureau/crew/` and your whole team gets the crew on `git pull`.

---

## Where things live

```
your-repo/
  canon/               the workspace (committed — this IS your memory; default name)
    decisions/ …       cabinet drawers (the canon)
    logbook/           append-only session history
    _config.json       render config (title/home/provenance + sidebar order — see below)
    _log.jsonl         the decision log (committed — source of truth for the freshness engine)
  bureau/crew/         the crew you enabled/authored — bureau's control dir, never rendered
  gazette/             the rendered gazette (gitignored — derived, rebuild any time)
  .bureau-cache/       the engine's derived gate cache (gitignored — regenerable by `gazette fsck`)
  BUREAU.md            the instructions init writes (trust gate + how to use the canon)
  CLAUDE.md            imports BUREAU.md (@BUREAU.md), so every session loads it
  .claude/agents/      crew agents, materialized by bureau:crew (generated — edit the source)
```

`canon/` is the content (rename-able via `--workspace`, just not to a reserved name like `bureau`
or `crew`); `bureau/` is reserved for bureau's machinery — the two are always separate directories.
The workspace holds only **source + committed decisions** (pages, `_log.jsonl`, the ledgers,
`_config.json`); every **derived** artifact lives *outside* it — the rendered board in `gazette/`,
the engine's gate cache in `.bureau-cache/`, both gitignored and rebuildable any time.

### Sidebar order

By default the left sidebar orders sections by top-level folder name (use `NN-` prefixes like
`00-`, `10-` to control it) and appends generated sections (Timeline, Graph, Health) last. To set
the order **explicitly**, list section ids in `_config.json`'s `groups[]` — the array order is the
sidebar order, and it can position generated sections too:

```json
{
  "meta": { "title": "…" },
  "groups": [
    { "id": "", "label": "Overview" },
    { "id": "decisions" },
    { "id": "logbook" },
    { "id": "health" }
  ]
}
```

Listed sections render in that order; anything unlisted keeps its folder/append order after. An
absent or empty `groups` = the default folder order (fully backward-compatible).

The workspace is plain markdown in your repo — diff it, review it in PRs, edit a typo by hand.
bureau just keeps it consistent and gated.
