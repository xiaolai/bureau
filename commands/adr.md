---
description: Record an architecture decision — scaffold a proposed MADR ADR page (auto-numbered, optionally superseding a prior one) into the canon. Authors only; a human approves it via bureau:review.
argument-hint: "\"<title>\" [--supersedes <ADR-N>] [--workspace <name>]"
---

# bureau:adr

Capture an architecture decision as a **MADR** ADR page in the canon — auto-numbered, with the
standard sections (Context · Drivers · Options · Outcome · Consequences · Confirmation) and, when one
is named, a `supersedes` edge to the ADR it replaces.

The page is authored at tier **`proposed`** and routed through the normal gate: it becomes fact only
when a **human** approves it via `bureau:review`. A supersession likewise takes effect only once the
superseding ADR is approved and content-current (ADR-0006). This command never approves and never
writes the decision log.

Follow the protocol in the **adr** skill (`skills/adr/SKILL.md`). In short:

If no title was given, ask the user for the decision title before proceeding.

1. Locate the workspace (`bureau.json`; default `canon`). If none, tell the user to run
   `bureau:init` first and stop.
2. Scaffold the page with the bundled press — pass each argument as its own token (never interpolate
   the title into a shell string):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" adr new --title "<title>" [--supersedes <ADR-N>] --dir <workspace>
   ```

   The verb mints the opaque `id:`, computes the next ADR number, resolves `--supersedes` to the
   target ADR's title (an unknown target fails loudly — nothing is written), and writes a
   `proposed` / `kind: adr` page atomically. It never touches `_log.jsonl`.
3. Fill the MADR body from the session — Context and Problem Statement, Decision Drivers, the
   Considered Options and the chosen Decision Outcome (with justification), Consequences, and a
   **Confirmation** that names how the decision is verified (fingerprint the confirming artifact with
   `gazette ledger verify` so drift re-flags the ADR). Edit the body prose only; **never** set
   `status`/`trust`, and never add an approval marker.
4. Report the result — in the format below.

**Output format.** One line: `Created <path> (ADR-<NNNN>, proposed) — awaits bureau:review.` When
`--supersedes` resolved a target, add a second line: `Supersedes <target title> — the supersession
activates only once a human approves this ADR.`
