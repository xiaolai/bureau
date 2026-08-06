---
name: approve-all
description: Prepare a human bulk-approval of the whole approvable review backlog — show what would be promoted to canonical, take an in-session confirmation, then hand the human the single pre-filled `gazette approve --all --by human` line to fire themselves. Use when running bureau:approve-all, or when the user asks to approve everything / approve the whole queue / bulk-approve at once. The AI never runs approve and never signs `--by human`.
argument-hint: "[--workspace <name>]"
---

# Approve-all — a one-confirmation human bulk-approval, prepared not forged

This is the fast path to draining the review backlog: promote every approvable claim to `canonical`
in one go. The catch it respects — the AI must not sign for you. So it does everything up to the
write (find the batch, show it, confirm it) and then hands you the exact one-line command to run
yourself. You fire it; the log records `by: human` because a human really did.

## Why the AI hands off instead of committing

`canonical · by human` is supposed to attest that a human approved (ADR-0004, BUREAU.md). The
decision log is unsigned, so `by:` is a claim, not proof — the whole gate rests on the AI never
writing `by: human`. An in-session "yes" cannot be seen at the log layer: if the AI's process ran
the approval, every `by: human` entry would become indistinguishable from a fabricated one. Running
the command yourself (via the `!` prefix) keeps the attestation true at one keystroke. `approve
--all` is also a **documented weakening** (ADR-0005) — it promotes the backlog sight-unseen — which
is all the more reason it is the human's to fire.

## Steps

1. **Locate the workspace.** Read `bureau.json` for the workspace dir (default `canon`); honor
   `--workspace <name>`. If no workspace exists, tell the user to run `bureau:init` first and stop.

2. **Build and split the queue.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" review --json --dir <workspace>`. Parse
   `{items, counts, total}` and split by kind:
   - **approvable** — `approve` and `reapprove`: exactly what `approve --all` promotes.
   - **not covered** — `confirm-dependencies`, `resolve-conflict`, `repair-edge`: `approve --all`
     leaves these untouched (a confirm can't be an approve, a conflict needs a decision, a broken
     edge needs an edit). They stay in the queue.

   If `review --json` exits non-zero or returns output that is not valid JSON, report the raw error
   and stop — never fabricate the queue or hand off a run command against an unknown backlog.

3. **Stop if there is nothing to approve.** If the approvable set is empty, report "nothing to
   bulk-approve" plus any not-covered items, and stop. Never confirm approving an empty batch.

4. **Show the batch, then confirm in-session.** List the approvable titles (what would become
   `canonical`) and the not-covered items. Then take the confirmation with `AskUserQuestion`:
   "Approve all N page(s) as canonical — by you (`by: human`)?" with options **Approve all** and
   **Cancel**. On **Cancel**, stop — nothing is approved.

5. **Hand off the one line (never run it yourself).** On **Approve all**, resolve the absolute path
   to `gazette.mjs` (expand `${CLAUDE_PLUGIN_ROOT}`) and print the ready-to-run command, `--dir`
   pre-filled, for the human to fire with the `!` prefix:

   ```
   ! <abs path>/press/bin/gazette.mjs approve --all --dir <workspace> --by human
   ```

   Explain briefly: running it via `!` executes it **as you**, so `by: human` is true; it is
   non-interactive, so it proceeds without a y/n and content-binds each page (capturing every
   digest, refusing any page it cannot bind). Do **not** run `gazette approve` yourself, and do
   **not** pass `--by human` from your own process.

6. **Offer the reviewed alternative.** Note that if approving sight-unseen is too blunt, a per-page
   reviewed batch keeps human authorship AND records exactly the bytes vetted:
   `gazette review --json > decisions.json` → prune it → `approve --from decisions.json --by human`;
   and that `bureau:codex-review` can pre-screen the queue first.

## Rules

1. **The AI never approves and never signs `--by human`.** It prepares and hands off; the human runs
   the one line. This is the non-negotiable core of the gate.
2. **Confirm before handing off.** Always show the batch and take an explicit in-session confirmation
   first — an empty or unconfirmed batch is never handed a run command.
3. **Only approve/reapprove are in scope.** Name the not-covered items so the user knows the queue is
   not fully cleared; route them to `bureau:review`.
4. **Name the weakening.** `approve --all` promotes sight-unseen (ADR-0005); say so, and offer the
   `approve --from` per-page alternative.
5. **Read-only until the handoff.** The skill only reads the queue; the sole state change happens when
   the human runs the printed line.

## Output format

Report, in order: (1) the **workspace**; (2) **would approve** — the count and titles that become
`canonical`; (3) **not covered** — the `confirm`/`resolve`/`repair` items left in the queue; (4)
**your one line** — the exact `! … approve --all --dir <workspace> --by human` command, plus the
`approve --from` reviewed-batch alternative.

## Example

<example>
Context: a repo with a bureau canon; six proposed claims and one contested pair await review.
user: "bureau:approve-all"
assistant: "In `bureau/`, `approve --all` would promote **6** page(s) to canonical: [Retry Policy,
Token TTL, …]. **Not covered:** 1 resolve-conflict (Auth model × Session model) — that needs a
decision, not an approval, so it stays in the queue. Approve all 6 as canonical, by you?"
[AskUserQuestion → Approve all]
"Fire this yourself — it runs as you, so `by: human` is true:
`! /Users/…/press/bin/gazette.mjs approve --all --dir bureau --by human`
(Prefer to vet per page? `gazette review --json > decisions.json`, prune it, then
`approve --from decisions.json --by human`.)"
<commentary>The AI shows the batch, confirms, and hands off — it never runs approve or signs
`--by human`. The contested pair is surfaced as out of scope, not silently bulk-approved.</commentary>
</example>

## Scope note

This skill ONLY prepares a human bulk-approval and hands off the command. It does not run any
approval, capture sessions, compile the logbook, resolve conflicts, or render the board. It is
invoked by `bureau:approve-all`, and is the bulk companion to `bureau:review` (per-page human gate)
and `bureau:codex-review` (Codex pre-screens the queue as your representative).
