---
description: The human double-check gate — review AI-written cabinet claims and promote the vetted ones to canonical, reject the rest.
argument-hint: "[--workspace <name>]"
---

# bureau:review

Vet what the AI wrote to memory before it is trusted as fact. AI-written claims land at tier
`proposed` (or `verified` when machine-checkable); only this gate promotes a claim to
`canonical`, and only on your approval. The cabinets are repo memory — an un-reviewed claim is
an unverified claim.

Follow the protocol in the **review** skill (`skills/review/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. Re-check staleness: recompute the source fingerprints in `_verify.json`; demote any
   page whose source changed to `stale`. Skip if the ledger is absent.
3. Build the queue of every page not yet `canonical` (`proposed`, `verified`, `stale`). If it is
   empty, report "nothing to review" and stop.
4. Present a batch digest — each claim with its `[[session …]]` provenance and its check result
   (auto-verified against an artifact, or a judgment that needs your eye). Group facts apart
   from judgments.
5. Take the decision per claim: approve → `status: canonical` + today's `verified:` date;
   reject → remove the claim and append a one-line note to the current logbook entry (history
   is kept, not erased).
6. Run `bureau:inspect`, then report counts approved / rejected / pending and any `contested`
   pages (those are resolved by re-deciding in a session, not here).
