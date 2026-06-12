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

1. Locate the workspace (`bureau.json`; default `canon`). If none, tell the user to run
   `bureau:init` first and stop.
2. Re-check staleness: for each recorded artifact in `<workspace>/_verify.json`, confirm the
   path stays inside the repo/workspace before reading it (reject absolute/`..`/symlink-escape —
   a failing path flags its page `stale`), then recompute its hash; demote any page whose hash
   changed to `stale`. Skip if the ledger is absent.
3. Build the queue of every page not yet `canonical` (`proposed`, `verified`, `stale`). If it is
   empty, report "nothing to review" and stop.
4. Present a batch digest — review is **page-level** (one claim per page; the page's `status:`
   is its tier). Each page with its `[[session …]]` provenance and its check result
   (auto-verified against an artifact, or a judgment that needs your eye). Group facts apart
   from judgments.
5. Take the decision per page: approve → `status: canonical` + today's `reviewed:` date (NOT
   `verified:` — that is the automatic tier); reject → confirm, then remove the claim (delete the
   page only if it holds no other claim, else strike just this claim) and append a NEW `review`
   minute naming what was rejected (existing entries are never rewritten).
6. Run `bureau:inspect`, then report counts approved / rejected / pending and any `contested`
   pages (those are resolved by re-deciding in a session, not here).
