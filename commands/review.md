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
3. Build the queue with `gazette review --dir <workspace>` (ADR-0005) — it returns the review work
   items in dependency order (upstream-first), each typed by its action (`approve` · `reapprove` ·
   `confirm-dependencies` · `resolve-conflict` · `repair-edge`). If it is empty, report "nothing to
   review" and stop.
4. Present a batch digest — review is **page-level** (one claim per page; the page's `status:`
   is its tier). Each page with its `[[session …]]` provenance and its check result
   (auto-verified against an artifact, or a judgment that needs your eye). Group facts apart
   from judgments.
5. Prepare the decision per page — the **human** commits it. The AI never runs `gazette approve`/
   `reject` or asserts `--by human` (BUREAU.md + ADR-0004); hand the human the exact command to run
   themselves — `gazette approve "<title>" --dir <workspace> --by human` (or
   `… reject … --by human [--reason "…"]`). `canonical`/`reviewed` are **projections** of the logged
   approve event — do NOT author `status: canonical` yourself. For a reviewed backlog the human may batch
   (still their command, never yours): seed a manifest with `gazette review --json` (each approvable item
   carries its `digest`), then `approve --from decisions.json --by human` (per-page digests, atomic) — or
   `approve --all --by human` (bulk — a documented weakening, ADR-0005). For a reject, once confirmed, remove the
   claim (delete the page only if it holds no other claim, else strike just this claim) and append a
   NEW `review` minute naming what was rejected (existing entries are never rewritten).
6. Run `bureau:inspect`, then report counts approved / rejected / pending and any `contested`
   pages (those are resolved by re-deciding in a session, not here).
