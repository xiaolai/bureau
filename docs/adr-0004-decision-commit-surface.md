# ADR 0004 — the decision-commit surface (content-bound approval, projection-only trust, honest authority)

**Status:** accepted (direction) · **Date:** 2026-07-31 · **Lineage:** an investigation of the
approval UX plus two Codex (`gpt-5`-class) reviews — a design discussion and an adversarial review of
the implementation plan — both verified against the engine source. The executable, phased plan lives
in `dev-docs/approval-ux-plan.md` (not shipped — this ADR is the committed record). This ADR **extends
ADR-0001** (the recursion-engine data model): it revises the `approve`/`reject` event shapes and
ratifies how effective trust is committed and read. Sub-decisions remain open (§Open).

## Context — three approval surfaces, one broken premise

ADR-0001 established that `canonical` is a **projection of a logged `approve` event**; `fsck` flags an
authored `canonical` with no backing event as `unbacked-canonical`. Yet approvals are committed across
three surfaces with inconsistent behavior:

- the chamber web UI (`scripts/serve.mjs applyDecision`) authors `status: canonical` in frontmatter and
  **never appends to `_log.jsonl`** — every browser approval is `unbacked-canonical`;
- `skills/review/SKILL.md:52` has the **AI** run `gazette approve` — the exact act BUREAU.md's write
  gate forbids;
- `state.mjs:47` `reject` un-approves with **no authority check** — any writer can revoke a human
  approval (`reject` is absent from `policy.mjs DECISIONS`);
- no approval is **content-bound**: the log's CAS protects concurrency, not that the reviewed bytes are
  the current bytes (a review time-of-check/time-of-use gap).

**The premise that motivated "make the chamber the human gate" is false.** `serve.mjs:586` prints the
reviewer token to **stdout**, and `bureau:serve` (`commands/serve.md:27`) has the **AI** start the
server and read that stdout — so the token is already in the AI's context; the "do not echo it" note
(serve.md:34) is too late. There is **no human-authentication boundary** in bureau today. As
`policy.mjs:48–53` already states, `by` is a **cooperating-pipeline capability, not authentication**;
the log guarantees tamper-*evidence*, not identity. Every surface rests on AI discipline equally.

## Decision A — name the authority model honestly; one boundary upgrade

bureau's trust gate is an **integrity control over a cooperating pipeline**, not an authentication
boundary — the design adopts this framing explicitly and drops any copy claiming a surface "proves a
human." `by: "human"` is an asserted authority **class** (ADR-0001), and the log's guarantee is
tamper-evidence via the integrity chain, not non-repudiation.

The **single** change that upgrades the chamber from best-effort to a real boundary is **out-of-band
human start**: `bureau:serve` is re-specified so the **human** starts the chamber themselves and the
reviewer token **never enters the AI's context** (the AI hands the user a command to run, and does not
read the server's stdout). Absent that, the chamber is exactly as trustworthy as the CLI — cooperative
discipline. This ADR adopts the honest cooperative framing for the correctness work, and the
out-of-band start as the one boundary upgrade; stronger identity (signed events / WebAuthn / OS
credential) is out of scope and noted for a future ADR.

## Decision B — approval is a content-bound, authority-gated log transaction

A promotion to `canonical` is a **single log append** — never a frontmatter write — carrying a
versioned **semantic page digest** and (for revocations) a scoped target. This revises ADR-0001's
Schema 1 events:

```jsonc
{ "type": "approve", "id": "<uid>", "to_trust": "canonical", "by": "<actor>", "hash": "<page-digest>" }
{ "type": "reject",  "id": "<uid>", "approval_seq": <seq>, "approval_hash": "<page-digest>", "by": "<actor>" }
```

- **Content binding.** `approve.hash` is a `bureau-page-v1` semantic digest —
  `sha256(canonicalJSON({ version:1, uid, title, semanticFrontmatter, normalizedBody }))` — computed by
  a new pure module `press/src/engine/review-digest.mjs` during the same read as `loadCorpus` (never the
  chamber's permissive `serve.mjs:214` parser). It **includes** authored/semantic keys (`id`, `title`,
  `claim`, `kind`/`type`, provenance, typed relations, `rests_on`, unknown authored keys) and
  **excludes** a fixed, reviewed list of derived/cosmetic keys (`status`, `trust`, `effective_status`,
  `reviewed`, `verified`, `updated`, `age`, `words`, `icon`, `group`); it normalizes conservatively
  (BOM, CRLF→LF, NFC, trailing horizontal whitespace, terminal newline) without collapsing
  Markdown-significant internal whitespace. An approval is **effective only while `hash` equals the
  current page digest** — a meaningful edit after approval demotes it (finding `stale-approval`); a
  logged approval with no `hash` (legacy) is reported `unbound-approval`, never silently treated as
  current. (Binding to ADR-0001 span hashes is insufficient — unanchored prose and semantic frontmatter
  are uncovered, and the scan may itself be pending.)
- **Reject reuses the `approve` authority** — it is **not** a new `policy.mjs DECISIONS` key. A separate
  key would churn every non-default `policyMarker`/snapshot digest and permit nonsensical "may revoke
  but not grant" policies. `projectDecisions` gates revocation with `isAuthorized(policy, "approve", by)`
  and **scopes** each reject to the active approval (`approval_seq`/`approval_hash`): an unauthorized,
  stale, or duplicate reject is inert (recorded as `unauthorizedRejections` / `staleRejections`), never
  superseding an effective decision. This fixes the unconditional `state.mjs:47` delete and handles
  `approve A1 → reject A1 → approve A2 → delayed reject A1 (inert)`. Legacy unscoped rejects are honored
  as human revocations but reported `unscoped-legacy-reject`.
- **Content-bound POST.** The chamber (and any committing surface) returns a decision **envelope**
  `{ uid, path, title, effective_trust, page_digest, observed_log_seq, freshness }`, and the commit
  re-reads, re-hashes, re-checks freshness, then `compareAndAppend(observed_log_seq, event)` — rejecting
  a review taken against a since-changed page or log head.
- **Stable identity required.** Approval requires an **authored `id:`** (ADR-0001 §B) — a title-derived
  shim uid orphans the approval on rename (`model.mjs:112`); migration/enable stamps `id:` before review.

## Decision C — effective trust is projection-only; authored `status:` is never overwritten

`canonical` and `reviewed` are read **only** from the log projection (`state.mjs projectDecisions` +
`fsck`). Authored frontmatter carries only `proposed`/`verified` **intent** and is **never** rewritten
by a decision — overwriting `status:` would destroy the base state needed when an approval goes stale or
is rejected. For plain-file legibility (grep the canon; teammates without the engine; the offline
gazette) a **derived, non-authoritative** `effective_status:` may be materialized by an **explicit**
`gazette fsck --materialize-pages` (net-new; today `fsck` writes only the external gitignored gate
cache — plain `gazette fsck` must not mutate source pages). All authoritative readers ignore
`effective_status:` as input. Reader surfaces that today key off authored `status:` — the chamber queue
(`serve.mjs:225`), the graph (`build.mjs:367` uses `n.trust || n.status`), and the recall/query/status
skills — convert to **effective** trust, and an approved page leaves the pending queue immediately.

## Decision D — legacy migration by a digest-pinned grandfather manifest, not backfill

Existing authored `canonical` pages with no backing event are **not** bulk-approved — a human running
one command is not a human vetting every claim, and BUREAU.md forbids the AI asserting `by:human`.
Instead a **human-initiated, committed, digest-pinned `legacy-canonical` manifest** (`{uid, page_digest}`
per existing authored canonical) grandfathers them: they project as `legacy-canonical` (**not**
`approved`), display as "grandfathered — not review-backed," and **any** meaningful content change (or a
digest mismatch) invalidates the entry. A real chamber approval replaces it; the manifest is removed
when empty. A blanket `_config.json` flag is rejected as too broad (it would also bless newly authored
canonicals).

**Implemented** (`engine/legacy.mjs`, `fsck`, `gazette legacy-migrate [--check]`): the manifest also
covers a real-but-**unbound** approval (one predating content-binding, no `hash`), pinning its current
digest. A grandfathered page draws the **advisory** `legacy-canonical` finding instead of the blocking
`unbacked-canonical` (or the `unbound-approval` nudge); a digest mismatch drops the grandfather and it
blocks again. The command never appends a decision event — it only writes the honest, weaker
`legacy-canonical` pin.

## Consequences

- The chamber stops manufacturing fsck-invalid canon; the log is the single serialization point for a
  promotion; the two-file (JSONL + frontmatter) atomicity problem disappears.
- The AI never commits a human-authority event — `bureau:review` **prepares and presents**, the human
  commits. This resolves the standing BUREAU.md contradiction by construction.
- New fsck findings: `stale-approval`, `unbound-approval`, `unauthorized-reject`,
  `unscoped-legacy-reject`. `reject` becomes authority-gated and scoped.
- Sequencing constraint: the chamber log-transaction (plan Phase 4) **must** ship with the
  reader-projection slice (Phase 3) — shipping the chamber alone yields contradictory UI (log says
  canonical; page/queue/graph say proposed; page re-approvable). CLI footguns (`--by` default; unbound
  `runApprove`; `reject` with no `by`) are closed first (Phase 2).
- `gazette serve` (bundled static server, no review endpoints) and `bureau:serve` (the chamber) are
  distinct; chamber engine imports are valid only on the `bureau:serve`/`scripts/serve.mjs` path (or the
  chamber moves into `press/src` and is bundled).

## Implementation status (as shipped)

- **Shipped + verified:** the honest cooperative authority model (Decision A); content-bound approvals
  with a semantic `reviewDigest` (Decision B); authority-gated, scoped `reject`; the CLI `--by`
  requirement + content-bound `runApprove`; the chamber log-first transaction; the `bureau:review`
  prepare-and-present skill; the Phase-6 `legacy-canonical` grandfather migration (`gazette
  legacy-migrate`); and — the enforcement payoff — **content-binding is now enforced on all three
  reader surfaces**: `stale-approval` **blocks** `fsck` (the gate), a stale approval **re-enters** the
  chamber review queue as `needs-review`, and the board **flags** it on the canvas + Health page. The
  single projection helper `engine/effective.mjs` (derived from `fsck`) gives every reader one answer.
- **Remaining Decision-C refinement (not a correctness gap):** the chamber still writes a transitional
  frontmatter **dual-write** — it overwrites authored `status: proposed → canonical` on approval rather
  than writing a derived, non-authoritative `effective_status:` and preserving the authored base state.
  Completing it is a *coordinated* change (the chamber writes `effective_status:`; the board **tier**
  and the recall/query/status skills key off the log projection instead of authored `status:`; the
  optional `gazette fsck --materialize-pages` refreshes the legibility cache for pages the chamber did
  not decide). The log is already authoritative and enforcement is live on every surface, so this is a
  base-state-provenance/purity improvement, sequenced but not blocking.

## Open

1. **Boundary posture** — is out-of-band human-start (Decision A) **mandatory** for the chamber, or an
   opt-in "strict" mode with the cooperative model as default? (Leaning opt-in default-off until the
   `bureau:serve` UX for a human-started server is designed.)
2. **Raw `gazette approve`** — retire it as a committing surface, or keep it interactive + content-bound
   + CAS for a human at a terminal? (Leaning: keep, but require explicit `--by` and a content digest.)
3. **Digest exclude-list** — the fixed non-semantic key set is provisional; finalize it against the full
   authored-frontmatter grammar before `review-digest.mjs` freezes at `v1`.
4. **Chamber home** — keep the chamber in `scripts/serve.mjs`, or move it into `press/src` + the bundle
   so `gazette serve` can host it? (Affects whether the review UI ships in the self-contained bundle.)
