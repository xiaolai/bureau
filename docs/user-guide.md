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
| "What needs my attention?" | `bureau:status` | uncompiled / pending-review / stale / contested counts |
| Read it as a human | `bureau:inspect` | build + open the offline gazette |

Capture is cheap and frequent; review is the deliberate, valuable step. You can let proposed
claims pile up and review them in a batch.

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
  bureau/crew/         the crew you enabled/authored — bureau's control dir, never rendered
  gazette/             the rendered gazette (gitignored — derived, rebuild any time)
  BUREAU.md            the instructions init writes (trust gate + how to use the canon)
  CLAUDE.md            imports BUREAU.md (@BUREAU.md), so every session loads it
  .claude/agents/      crew agents, materialized by bureau:crew (generated — edit the source)
```

`canon/` is the content (rename-able via `--workspace`, just not to a reserved name like `bureau`
or `crew`); `bureau/` is reserved for bureau's machinery — the two are always separate directories.

The workspace is plain markdown in your repo — diff it, review it in PRs, edit a typo by hand.
bureau just keeps it consistent and gated.
