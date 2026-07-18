---
description: Report the state of the bureau — uncompiled sessions, pages by trust tier, dependency freshness (needs-review/stale from the recursion engine), and what needs your attention.
argument-hint: "[--workspace <name>]"
---

# bureau:status

A text dashboard of the workspace: what's captured but not yet canon, what's drifted out of
`current`, and what's waiting on you. Read-only; it changes nothing.

## Steps

1. Locate the workspace (`bureau.json`; default `canon`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Uncompiled sessions.** Count minutes whose session id is NOT in
   `<workspace>/_compile-state.json` — these are filed but not yet distilled (`bureau:compile`).
3. **Pages by tier.** Scan the cabinet drawers (exclude `logbook/`, `board/`, `lint/`, and
   `_`-prefixed) and tally each `status:` — `proposed`, `verified`, `canonical`, `stale`,
   `contested`.
4. **Dependency freshness (the recursion engine).** Run
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" gate --dir <workspace>` and include its
   **needs-review** count (pages resting on a changed upstream span) and **stale** count (broken
   dependencies), plus the cutoff ratio it reports beside the tracked-edge count. This is the
   *dependency* freshness — distinct from tier `stale`. If the command fails, note that engine
   freshness is unavailable and continue (don't abort the report).

   The gate is *point-in-time* (what is dirty right now). For the *trend* — is the canon
   **converging** (the queue drains, repeated firings fall) or **thrashing** — also run
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" telemetry --dir <workspace>` and include its
   one-line verdict (`drained` / `stabilizing` / `thrashing`) with the queue depth beside it. Optional
   and read-only; skip silently if it fails.
5. **Needs attention.** Combine both axes: pages awaiting review by **tier** (`proposed` +
   `verified`), `contested` pages (unresolved conflicts), and pages flagged by **freshness**
   (`needs-review` / `stale` from step 4). A page can appear for both reasons.
6. **Structural health.** Run `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" health
   --dir <workspace>` and include its dangling/orphan counts. If that command fails (script
   missing or a non-zero exit), skip those counts and note that structural health is
   unavailable — do not abort the status report.
7. **Report** a compact summary table and the one or two next actions it implies (e.g. "3
   uncompiled → `bureau:compile`; 5 awaiting review + 2 needs-review → `bureau:review`; 1 contested
   → resolve in a session"). If everything is canonical, current, and structurally clean, say so.
