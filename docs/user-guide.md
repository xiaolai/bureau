# bureau — User Guide

This guide is for the person *driving* bureau. (The other audience — any AI session working in
your repo — is governed automatically by the **recall rule** that `bureau:init` installs; you
don't manage that.)

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

That scaffolds a `bureau/` workspace (your cabinet drawers + a `logbook/`), installs the recall
rule into `.claude/rules/`, and gitignores the rendered board. Then the loop:

```
… work a normal AI session …
/bureau:note          # at each real decision — jots a live minute
/bureau:file-session  # at the end — files the full entry
/bureau:compile       # distil the new sessions into cabinet pages
/bureau:review        # approve the vetted claims → canonical (the double-check)
/bureau:query "…"     # ask the canon anything, later
/bureau:inspect       # open the board to read it as a human
```

You don't need all of them every time — see *What to run when* below.

---

## A worked example

You spend a session deciding your auth token lifetime.

1. **Mid-session, a decision lands.** `/bureau:note` →
   appends to `bureau/logbook/2026/06/<session>.md`:
   > checkpoint 14:30 — decided: auth tokens last 24h (security review). open: refresh-token TTL.

2. **End of session.** `/bureau:file-session` finalizes that entry — intent, decisions, changed
   files, open threads — append-only history. (If you forget, a `SessionEnd` hook still saves a
   stub, and a compaction mid-session re-grounds the agent from the logbook.)

3. **Distil to canon.** `/bureau:compile` reads the new logbook entry and writes a cabinet page:
   ```
   bureau/decisions/token-ttl.md   →  title: Token TTL   status: proposed
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
| After one or more filed sessions | `bureau:compile` | turn logbook entries into cabinet pages |
| You have a few minutes to vet memory | `bureau:review` | promote vetted claims to `canonical` |
| Before a milestone / periodically | `bureau:lint` | catch contradictions, gaps, drift across the canon |
| You need to recall something | `bureau:query "…"` | tier-aware answer with citations |
| "What needs my attention?" | `bureau:status` | uncompiled / pending-review / stale / contested counts |
| Read it as a human | `bureau:inspect` | build + open the offline board |

Capture is cheap and frequent; review is the deliberate, valuable step. You can let proposed
claims pile up and review them in a batch.

---

## Reading the canon — the trust tiers

Every cabinet page carries a `status:`. It travels with the claim, so an unverified one can
never pass as fact:

| `status:` | meaning | trust |
|-----------|---------|-------|
| `canonical` | a human (you) approved it | **fact** |
| `verified` | auto-checked against the repo, not yet approved | checked — reconfirm if load-bearing |
| `proposed` | an AI claim, unchecked | **not fact** — verify before relying |
| `stale` | a verified source changed since the check | outdated — re-verify |
| `contested` | two claims disagree | disputed — resolve before relying |

`bureau:query` enforces this for you. And because `init` installed the **recall rule**, *any*
AI session in the repo is told to honor these tiers when it reads the cabinets as memory and to
route new claims through capture → compile → review — never straight to canon.

---

## Maintenance

- **`bureau:status`** is your dashboard: how many sessions are uncompiled, how many pages await
  review, what's stale or contested. It tells you the one or two next actions.
- **`bureau:lint`** sweeps for semantic problems the structural check can't see (contradictions
  between pages, superseded claims, gaps, vocabulary drift). Run it before a milestone. With
  `--apply` it marks the hard cases (`contested`/`stale`) so the board surfaces them.
- **Contested pages** are resolved by *re-deciding* in a session (then recompile + review), not
  by editing the canon directly.
- **Stale pages** mean a source the claim depended on changed — re-verify and re-approve.

---

## Where things live

```
your-repo/
  bureau/              the workspace (committed — this IS your memory)
    decisions/ …       cabinet drawers (the canon)
    logbook/           append-only session history
  board/               rendered board (gitignored — derived, rebuild any time)
  .claude/rules/bureau.md   the recall rule (installed by init)
```

The workspace is plain markdown in your repo — diff it, review it in PRs, edit a typo by hand.
bureau just keeps it consistent and gated.
