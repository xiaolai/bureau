---
description: Run the full bureau maintenance lifecycle in one pass — compile pending minutes into dossiers, scan the recursion engine for changed claims, lint for consistency, surface everything that needs human review (by trust tier AND freshness), and rebuild the gazette. Use when running bureau:cycle, or when the user asks to "run the whole pipeline", "bring the canon up to date", "process everything", or do an end-to-end maintenance pass.
argument-hint: "[--since <YYYY-MM-DD>] [--skip-lint]"
---

# bureau:cycle — the full lifecycle in one pass

The everyday maintenance command: take everything that has accumulated since the last pass — new
minutes, edited claims, drifted dependencies — and bring the canon back to a consistent, reviewed,
rendered state. It **orchestrates** the focused commands in order and **halts on any structural
failure**; it never promotes to `canonical` itself (that stays inside `bureau:review`, the human
gate) and never commits, pushes, or opens PRs.

The bundled press is at `${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs`; the workspace is named by
`<workspace>/bureau.json` (default `canon`, auto-detected).

## Steps (halt on any failure; report where you stopped)

1. **Locate the workspace** (`bureau.json`; default `canon`). If none, tell the user to run
   `bureau:init` first and stop.

2. **Compile.** Distil every uncompiled minute into dossiers with provenance — follow
   `skills/compile/SKILL.md` (apply `--since` if given). Facts-about-artifacts verify against the
   repo (recorded via `gazette ledger verify`); judgments stay `proposed`. A new claim that
   contradicts an existing one becomes `contested` with a `contradicts:` edge — never a silent
   overwrite. If there is nothing to compile, say so and continue.

3. **Scan (the recursion engine).** Record any changed claim spans into the decision log:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" scan --dir <workspace>
   ```
   This bumps `span_revision` for edited spans, so the gate can flag whatever now rests on a changed
   upstream. Report the introduce/edit/delete counts.

4. **Lint** (unless `--skip-lint`). Sweep the cabinets for free-text contradictions, superseded
   claims, and vocabulary drift — follow `skills/lint/SKILL.md`. Record only survivors (find →
   adversarially refute → keep what holds). This is the LLM-judgment pass; it's the slowest step, so
   `--skip-lint` exists for a quick cycle.

5. **Surface the review queue — tiers AND freshness.** Compute what needs a human:
   - **By tier:** every dossier at `proposed`/`verified`/`stale`/`contested` (not yet `canonical`).
   - **By freshness (the gate):**
     ```
     node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" gate --dir <workspace>
     ```
     which lists `needs-review` (rests on a changed upstream) and `stale` (broken dependency) pages.
   Then run the human gate — follow `skills/review/SKILL.md`: re-check staleness, present the batch
   digest, and on the human's approval promote via `gazette approve "<title>"` + set `canonical`,
   `confirm` still-valid dependencies via `gazette confirm "<title>"`, and record any conflict
   resolution via `gazette resolve`. Rejections append a minute; nothing is erased.

6. **Inspect + verify.** Rebuild the board and run the deterministic checks:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" build --dir <workspace> --out <board>
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" fsck --dir <workspace>
   ```
   `build` surfaces structural findings (dangling/orphan/contradiction/unsourced) + the live drift
   tally; `fsck` confirms the derived state rebuilds to a byte-fixpoint and flags any
   unbacked-`canonical` or tamper. Report both.

7. **Report.** One summary: minutes compiled, spans scanned, lint findings, pages approved / left
   pending (by tier and by freshness), and the board + fsck result. Name the single next action if
   anything is still pending.

## Rules

1. **Halt on structural failure.** If `compile`'s structural check, `build`, or `fsck` fails, stop
   and report — a failed step must not be papered over by later ones.
2. **Never promote to `canonical` outside step 5's human gate.** The gate is the whole point.
3. **No git side effects.** No commit, push, PR, or destructive command.
4. **Idempotent.** Re-running with nothing pending is a clean no-op that just reports "canon is
   current and reviewed."

## Examples

<example>
Context: several sessions have been filed and a few upstream claims were edited; the user wants to catch up.
user: "bureau:cycle"
assistant: "Ran the full pass: compiled 3 minutes into 2 new dossiers + 1 update; scanned 4 changed spans; lint found 1 superseded claim (set stale). Review queue: 2 proposed facts (auto-verified — build command, dep version), 1 needs-review page (**Query design** rests on **SSOT model** ^ssot-claim, which changed). You approved the two facts (→ canonical) and confirmed Query design still holds after reviewing the SSOT change. Rebuilt the gazette — health ✅, fsck fixpoint stable. Canon is current and reviewed."
<commentary>One pass moves new minutes through the gate AND reconciles the dependency drift the engine flagged.</commentary>
</example>

<example>
Context: a quick catch-up with nothing pending.
user: "bureau:cycle --skip-lint"
assistant: "Nothing to compile, scan found 0 changes, and the gate shows every page current. Skipped lint. Board rebuilt, fsck stable. The canon is already current and reviewed — no action needed."
<commentary>Idempotent: a clean cycle is a no-op that just confirms the canon is up to date.</commentary>
</example>

## Scope note

This command ORCHESTRATES the pipeline — it delegates the actual work to the focused skills
(`compile`, `lint`, `review`) and the press's engine verbs (`scan`, `gate`, `build`, `fsck`). It does
not itself author claims or promote them. For a single step, run that step's command directly.
