---
name: review
description: The human double-check gate for AI-written memory. Show every cabinet claim not yet approved — with its provenance and automatic check result — and let the human promote it to canonical or reject it. Use when running bureau:review, or when the user asks to approve / vet / sign off on what the AI wrote to memory before it is trusted as fact.
argument-hint: "[--workspace <name>]"
---

# Review — the gate between AI memory and trusted fact

AI-written memory must never be recalled as fact until a human has checked it. This skill is
that gate: a batch double-check that promotes vetted claims to `canonical` and discards the
rest. The cabinets double as repo memory, so an un-reviewed claim is an unverified claim.

## Trust tiers (the `status:` of every dossier)

| tier | meaning | written by | recalled as |
|------|---------|------------|-------------|
| `proposed` | AI claim, unchecked | compile | "unverified — verify before relying" |
| `verified` | passed an automatic ground-truth check | compile | "checked against the repo on `<date>`" |
| `canonical` | a human approved it | **review** (this skill) only | fact |
| `stale` | a verified source changed / a claim was superseded | review's staleness re-check; lint (`--apply`) | "was true on `<date>` — re-verify" |
| `contested` | two claims disagree | compile (conflict); lint (`--apply`) | "disputed — do not rely" |

(Capture writes the logbook, never a dossier — only compile, lint, and review touch a
page's `status:`.)

Only `canonical` is recalled as fact. Everything else carries its tier as a warning. The AI
never writes `canonical` itself — that tier exists only on the far side of this gate.

## What review does

1. **Locate the workspace** (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Re-check staleness first.** For each `verified`/`canonical` page, run
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" ledger recheck --dir <workspace> --page "<title>"`.
   The press (in code) re-hashes every recorded artifact from `<workspace>/_verify.json` —
   **path-jailed** inside the repo (absolute paths, `..` escapes, and symlinks pointing outside are
   rejected/reported, never read). Any page reporting `DRIFTED` (or an unreadable artifact) is
   demoted to `stale` and added to the queue. If the page has no recorded fingerprints, skip it.
3. **Build the queue.** Collect every dossier at tier `proposed`, `verified`, or `stale`
   (i.e. not yet `canonical`, or fallen out of it). If the queue is empty, report "nothing to
   review — the canon is approved and current" and stop.
4. **Present a batch digest.** Review is **page-level** — a page is one claim (compile keeps it
   so), and its `status:` is the page's tier. For each queued page show, in one compact block:
   - the page and its claim;
   - its **provenance** — the `[[session …]]` it traces to (and whether that link resolves);
   - its **check result** — `verified against <artifact>` for an auto-checked fact, or
     `unverifiable (judgment — needs your eye)` for rationale/design claims.
   Group facts (auto-verified) apart from judgments (need human reasoning) — the judgments are
   the ones that actually need the human.
5. **Take the human's decision** per page (ask in batches, not one-by-one):
   - **approve** → log the approval with
     `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" approve "<title>" --dir <workspace>` (the
     press appends an `approve` event to the decision log — `canonical` is a **projection of that
     event**, not the frontmatter alone; `gazette fsck` flags any authored `canonical` that no
     approval backs). Then set the page `status: canonical` and stamp `reviewed:` with today's date
     for display (`reviewed:`, NOT `verified:` — `verified` is the automatic-check tier, `reviewed`
     is the human stamp);
   - **reject** → confirm first, then remove the claim. If the page holds ONLY this claim,
     delete the page; if it carries other claims or provenance, strike just this claim and keep
     the rest — never delete unrelated content. Record the rejection by **appending a new
     minute** (a short `review` entry naming what was rejected and why) — do NOT rewrite
     an existing minute; the logbook is append-only history.
6. **Structural check.** Run `bureau:inspect`; report the gazette state.
7. **Report.** Counts approved / rejected / left pending, and the path to anything still
   `contested` (those are resolved by re-deciding in a session, not by review).

## Ground-truth, honestly

- A **fact about an artifact** (a path, a build command, a function signature, a config value,
  a dependency version, a commit) is mechanically checkable — `compile` marks it `verified`
  and review confirms. The fingerprint in `_verify.json` lets staleness auto-demote it later.
- A **judgment** ("we chose X because Y", "this module is fragile") cannot be verified, only
  **provenanced and read by a human**. Do not label a judgment `verified`; route it to the
  human in step 4. This is the split the gate exists for.

## Recall convention (how memory is read back)

Whoever reads the cabinets as memory MUST honor the tier on each claim: treat `canonical` as
fact; treat `verified` as checked-but-not-approved; treat `proposed`, `stale`, and `contested`
as claims to confirm before relying, never as fact. The tier travels on every recalled line so
an unverified claim can never masquerade as truth.

## Rules

1. **Human-gated.** Only this skill writes `canonical`, and only on an explicit human approval.
2. **Reject is guarded and logged, never silent erasure.** Confirm before removing; delete a
   page only when it holds no other claim; otherwise strike just the rejected claim. Record the
   rejection by appending a NEW minute — existing entries are never rewritten.
3. **No prose invention.** Review promotes, demotes, or removes claims — it does not author new
   ones. New claims come from `compile`.
4. **Stale before approve.** Re-check fingerprints (step 2) before presenting the queue, so the
   human never approves something the repo already moved past.

## Examples

<example>
Context: After a compile run, three dossiers sit at `proposed`/`verified`.
user: "bureau:review"
assistant: "I'll re-check staleness, then show the queue. 3 claims pending — 2 facts auto-verified against the repo (build command, dep version), 1 judgment ('the queue module is fragile') that needs your call. Approve the two facts and the judgment? You approved the facts; I set them canonical. You rejected the judgment; I removed it and logged the rejection to today's minute."
<commentary>The gate promotes vetted claims to canonical and logs rejections — facts and judgments are presented apart because only the judgment needs human reasoning.</commentary>
</example>

<example>
Context: A page `Build command` was `verified` last week; src has changed since.
user: "Vet what the AI remembered before I trust it."
assistant: "Running bureau:review. Staleness re-check first: `Build command`'s source fingerprint changed, so I demoted it to `stale` and added it to the queue rather than letting you approve a claim the repo already moved past."
<commentary>Step 2 re-checks fingerprints before presenting the queue, so a stale claim can't be approved as current.</commentary>
</example>

## Scope note

This skill covers ONLY the human approval gate and staleness re-check. It does **not** capture
sessions (`capture` / `bureau:file-session`), does **not** distil the logbook (`compile` /
`bureau:compile`), and does **not** run the semantic sweep (`lint` / `bureau:lint`). It acts on
the cabinets those produce and is invoked by the `bureau:review` command.
