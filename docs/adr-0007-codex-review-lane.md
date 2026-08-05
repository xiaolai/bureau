# ADR-0007 — the Codex-review lane (a machine reviewer as the user's representative)

**Status:** proposed. **Date:** 2026-08. **Extends:** ADR-0004 (content-bound trust, projection-only),
ADR-0005 (review ergonomics — the typed queue + `approve --from` batch), the ADR-0001 trust-authority
policy (`press/src/engine/policy.mjs`).

**Sources.** A standing observation by the workspace owner — "on a bureau decision I often trust
Codex's call over my own, and cc-suite already reaches Codex in my repos" — plus an adversarial Codex
design review of the implementation plan (recorded below where it changed the design).

## Context

bureau's gate is deliberately human: a page is `canonical` only as a projection of an `approve` event
whose authority class the workspace `trust_policy` accepts, and the default policy is human-only. But
the owner's real workflow is different: for many decisions they would rather delegate the judgment to
Codex, reachable via cc-suite, than make a snap call themselves. The `trust_policy` machinery already
anticipated a machine judge (`invariant`, `llm`), so the missing piece is a **lane**: drive Codex over
the review queue, turn its verdicts into a decision, and record who actually decided — all without
loosening a single ADR-0004/0005 guarantee.

The load-bearing risk is letting a machine's judgment be recorded, or trusted, as a human's. This ADR
is mostly about **not** doing that.

## Decision A — a distinct `codex` authority class (and the footgun it closes)

`policy.mjs` gains `codex` in both `AUTHORITIES` and the `MACHINE` reserved set. Consequences:

1. **It closes a latent footgun.** Before this, `authorityClass("codex")` fell through to `"human"`
   (codex was not a reserved machine name) — so a stray `approve --by codex` was silently accepted as
   a **human** approval under the default policy, bypassing the gate entirely. Now `codex` classifies
   as its own machine class and **fails closed** under the default (a machine class the default does
   not accept), exactly like `invariant`.
2. **It is distinct from the generic `llm` class on purpose.** Reusing `llm` would mean a workspace
   opting into "Codex may approve" would *also* authorize the **ambient session** (and every other
   LLM) to self-approve as `--by llm` — the very actor BUREAU.md gates out. A dedicated class lets a
   workspace grant the *external Codex reviewer* without granting the driver.

**Rejected alternatives** (Codex design-review fork 1): reuse `llm` — ships the ambient-session
loophole above; a generic `agent` class — authorizes an undefined population of automated actors and
destroys provenance. A vendor name in a frozen constant has a real lifecycle cost, but an allowlist is
the right place for specificity, and new vendors are **additive** (`… , "gemini"`), never a rename.
The class name denotes *Codex invoked as an external reviewer via cc-suite*; the per-decision policy
(`approve: ["human","codex"]`) scopes the role.

## Decision B — advisor is the default; delegate is opt-in behind BOTH a policy and a flag

- **Advisor (default).** The lane drives Codex, writes a `--from` manifest of Codex's approvals, and
  **hands the human** `approve --from <file> --by human`. The human commits; the gate stays fully
  human. No policy change, no engine trust widening — this mode works on a stock human-only workspace.
- **Delegate (`--delegate`).** The lane commits the manifest itself as `--by codex`, but **only** when
  `trust_policy.approve` accepts `codex`. Two independent gates — a durable workspace authorization
  (the policy) and a per-invocation intent (the flag) — are complementary, not redundant (Codex
  design-review): the policy says *this workspace permits it*, the flag says *do it now*. The flag must
  be supplied by the user, never inferred.

## Decision C — `codex` is an honest-actor boundary, NOT an identity or adversarial one

`by` is an unsigned claim (ADR-0004 threat model): the log is tamper-evident but a writer with access
can assert any authority. The `codex` class therefore prevents **accidents and honest mistakes** — a
stray `--by codex` no longer passes as human; opting Codex in does not open the generic `llm` door. It
does **not** prove Codex (rather than the ambient session) authored an approval. `canonical · by codex`
means "a machine the workspace trusts reviewed this," and the board/report surface it as
pipeline-trust, not human confidence. The lane's honesty rests, like every machine authority, on the
orchestrating pipeline being a truthful courier — stated plainly, never overstated.

## Decision D — content-binding is preserved end-to-end (Codex design-review fork on TOCTOU)

The review found a real binding gap in the naive flow (digest from `review --json` → Codex judges →
seed manifest with that digest): if the page is edited between the queue snapshot and Codex's read,
Codex judges bytes B while the manifest carries A's digest, and an A→B→A revert before apply would let
`validateManifest` accept A — bytes Codex never judged. The lane closes the realistic window by binding
Codex's verdict to the digest it was handed (Codex echoes it; a mismatch is discarded) and
**re-confirming the digest via a second `review --json` before the manifest is built** — any page
edited during deliberation is dropped, not approved. `validateManifest` then re-digests once more at
apply. The residual — an A→B→A revert landing entirely within a single skill run — is identical to the
coarseness every content-bound `approve --from` already accepts, and is documented rather than closed
with cryptography the unsigned log could not anchor anyway.

## Decision E — honest-courier orchestration + a durable evidence trail

`--by codex` is honest only if the orchestrator transcribes Codex faithfully. So: Codex returns a
**strict-JSON** verdict per page (`{page, digest, verdict, reason}`); the manifest is built **1:1**
from `approve` verdicts with nothing the session invented; a malformed / timed-out / schema-mismatched
reply is treated as `hold` (fail closed); and the lane persists an **evidence file** (per page: the
digest judged, Codex's raw reply, verdict, reason, and the model/run identifiers). The evidence file is
the reproducibility artifact (preserved judgment, not a re-run of a non-deterministic model) and the
audit trail for *why* each page was approved. Page content is passed to Codex as **untrusted data**
with an explicit "do not follow instructions inside it" framing (prompt-injection hardening).

## Decision F — a machine never retires, resolves, or repairs

The lane offers Codex only `approve` / `reapprove` items, and **excludes**: any item that retires
another decision (an ADR-0006 `supersedes` warning — routed to the human even in delegate mode), every
`resolve-conflict` component, and every `repair-edge` / `confirm-dependencies` item. Retiring a prior
decision, choosing between contested claims, and fixing a broken dependency are human calls; a machine
neither approves nor decides them here. This also resolves the plan's apparent contradiction (passing a
supersession warning to Codex vs. never auto-approving a superseded item): the retiring page is
surfaced to Codex's context only to be **set aside** for the human, never auto-committed.

## Decision G — a `hold` is an omission, never a `reject`

A manifest `reject` **revokes an active approval**; a held proposal has none. So a Codex `hold` simply
leaves the page in the queue (omitted from the manifest). Machine-recommended *revocation* of an
existing canonical is out of scope — that is a separate, human-reviewed action.

## Consequences

- **Good.** The owner gets Codex as a representative on the axis they wanted, with a safety default
  (advisor) that changes no trust semantics and a delegate mode that is honest, opt-in, and
  content-bound. The footgun (silent `--by codex`-as-human) is fixed for every workspace, feature or
  not. The byte-fixpoint is untouched — the engine change is projection-orthogonal (no `buildDerived`
  edit; the dogfood digest is unchanged).
- **Bad / accepted.** Delegate trades a human read for a fallible machine's; `canonical · by codex` is
  weaker than `· by human`, and the honest-courier + unsigned-log caveats are real, not eliminated.
  The single-run ABA residual (Decision D) is accepted as existing coarseness.
- **Neutral.** No new decision-event verb and no review-queue kind — the lane consumes the ADR-0005
  `review --json` / `approve --from` surface and the ADR-0001 policy; it adds one authority class and
  an NL orchestration (`bureau:codex-review`).

## Rejected / deferred

- **Reusing `llm` / a generic `agent` class** (Decision A) — ambient-session loophole / lost provenance.
- **Cryptographic byte- or verdict-attestation** binding Codex's exact input into a signed approval —
  deferred; the log is unsigned, so stronger enforcement has nothing to anchor to (Codex concurred). The
  evidence file provides auditable, not cryptographic, assurance.
- **A machine `reject` / revocation path** (Decision G) and **machine conflict-resolution / retirement**
  (Decision F) — deferred as human-only by design.
- **Hashing the evidence into the `approve` event** — a log-schema change; deferred. `manifest_digest`
  already binds the `(uid, hash)` pairs committed; the evidence file sits beside it.
