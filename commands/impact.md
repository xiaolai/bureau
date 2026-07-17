---
description: Show the pre-change blast radius of a dossier — which pages (transitively) rest on its claim, so you can see the review cost before you touch it. Use when running bureau:impact, or when the user asks "what depends on this?", "what breaks if I change X?", "who rests on this claim?", or "is this safe to edit?".
argument-hint: "\"<dossier title>\""
---

# bureau:impact — what rests on this claim

Before you change a dossier's claim, see everything that depends on it. `impact` walks the
`rests_on` graph in reverse (cycle-safe, each page at most once) and lists the dossiers that would
drop to `needs-review` if this page's claim changes. It reads only — it changes nothing.

This is the counterpart to the gate: the gate tells you what *has* drifted; `impact` tells you what
*would* drift, so you can weigh the cost of an edit up front (roadmap §4.7).

## Steps

1. Locate the workspace (`bureau.json`; default `canon`). Take the dossier title from `$ARGUMENTS`
   (quote it — titles have spaces). If empty, ask which dossier.
2. Run the press:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" impact "<title>" --dir <workspace>
   ```
3. Report the blast radius: the count and the list of dependent dossiers, or "nothing rests on it —
   safe to change." Frame it as *review cost*: changing this claim will flag those N pages for
   re-review (`bureau:review`).

## Notes

- Only **tracked** `rests_on` edges (object edges with a `^span`) contribute — a bare-string
  dependency is conservatively always `needs-review`, so it isn't a "would-drift" signal.
- A page with a large blast radius is a load-bearing claim; consider a `freeze:` hint on it, and be
  deliberate about editing its cited span vs. surrounding prose (only the **cited span** propagates).

## Examples

<example>
Context: the user is about to revise a foundational architecture decision.
user: "bureau:impact \"SSOT model\""
assistant: "Changing **SSOT model**'s claim would flag **4** dossiers for re-review: Query design, Compile design, Recall design, and Chamber intake — they all rest on `^ssot-claim`. That's the review cost; edit deliberately, and re-confirm those four (or `bureau:cycle`) after. Editing prose *outside* the `^ssot-claim` span propagates to none of them."
<commentary>impact quantifies the review cost before the edit and reminds that only the cited span propagates.</commentary>
</example>

## Scope note

This command ONLY reports the reverse-dependency blast radius. It doesn't edit, scan, or review. To
see what has *already* drifted, use `bureau:status` (the gate); to reconcile it, `bureau:review` or
`bureau:cycle`.
