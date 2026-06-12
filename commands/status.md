---
description: Report the state of the bureau — uncompiled sessions, pages by trust tier, and what needs your attention.
argument-hint: "[--workspace <name>]"
---

# bureau:status

A text dashboard of the workspace: what's captured but not yet canon, and what's waiting on you.
Read-only; it changes nothing.

## Steps

1. Locate the workspace (`bureau.json`; default `canon`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Uncompiled sessions.** Count minutes whose session id is NOT in
   `<workspace>/_compile-state.json` — these are filed but not yet distilled (`bureau:compile`).
3. **Pages by tier.** Scan the cabinet drawers (exclude `logbook/`, `board/`, `lint/`, and
   `_`-prefixed) and tally each `status:` — `proposed`, `verified`, `canonical`, `stale`,
   `contested`.
4. **Needs attention.** From those tallies: pages awaiting review (`proposed` + `verified`),
   `stale` pages (a verified source changed), and `contested` pages (unresolved conflicts).
5. **Structural health.** Run `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" health
   --dir <workspace>` and include its dangling/orphan counts. If that command fails (script
   missing or a non-zero exit), skip those counts and note that structural health is
   unavailable — do not abort the status report.
6. **Report** a compact summary table and the one or two next actions it implies (e.g. "3
   uncompiled → `bureau:compile`; 5 awaiting review → `bureau:review`; 1 contested → resolve in
   a session"). If everything is canonical and current, say the canon is clean.
