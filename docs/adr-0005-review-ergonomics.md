# ADR-0005 — review ergonomics for an N-page backlog

**Status:** proposed (committed once the Phase 1–5 semantics of `dev-docs/review-ergonomics-plan.md`
settle). **Date:** 2026-08. **Supersedes/extends:** ADR-0004 (decision-commit surface).

**Sources.** A field report on approving a 19-page backlog in one sitting
(`dev-docs/field-report-batch-approval.md`) and a critical review of the first plan draft. The field
report argued *never* ship `--all`; the workspace owner overrode that (ship it, gated) — this ADR records
the override honestly, including where it weakens the guarantee.

## Context

ADR-0004 made `canonical` a projection of the append-only decision log, with content-bound approvals and
projection-only trust. What it did **not** address is the *ergonomics of a real N-page backlog*: a
reviewer facing 17 proposed + 3 verified + 2 stale pages has no tool to order the work, no way to apply a
reviewed batch, and hits a confusing "approved but `status:` still says proposed." The friction of N
single-page invocations lands **after** the decision, so it taxes the careful and the careless reviewer
equally — and pushes the careless one toward a `for f; do approve "$f"; done` loop that guts the gate.

## Decision A — the review queue is typed work items over three orthogonal axes

A backlog is not a flat "approve these" list. Trust (`engine/effective.mjs`), dependency freshness
(`engine/gate.mjs` / `liveFreshness`), and conflict (`engine/state.mjs`) are **orthogonal** — a page can
be effectively `canonical` yet dependency-dirty (needs `confirm-edge`, not approve), and two pages can
both be approved while their contradiction stays `contested`. `review-queue.mjs` therefore returns
**typed work items** — `approve`, `reapprove` (stale), `confirm-dependencies`, `resolve-conflict` (a
component, possibly of >2 pages), `repair-edge` — ordered topologically over `rests_on` (SCC-condensed
for cycles), computed over `liveFreshness` so unscanned working-tree edits count. The CLI, chamber, and
review skill all consume this one function, so no surface can disagree.

It orders by **typed** edges only. A "reverses/supersedes" written in prose is invisible to the engine;
the queue catches a reversal **only** where a typed `contradicts` edge exists. No claim beyond that.

## Decision B — batch application is a commit-gated log transaction

`approve --from <manifest.json>` and `approve --all` apply many decisions in one invocation without
losing per-page judgment. Honesty about atomicity: append `batch-begin{batch_id, manifest_digest, mode,
n}` → one content-bound `approve` / scoped `reject` per entry → `batch-commit{batch_id}`, all under one
`appendBatch` lock on the `compareAndAppend` head sequence. **The projection ignores events inside an
uncommitted batch** — a crash before `batch-commit` means the batch never happened, and a rerun is
idempotent by `batch_id`. Each batch approval carries a **required** digest (a bare title is refused);
each reject is **scoped** (`approval_seq`/`approval_hash`) to the approval it revokes. Manifests are
JSON, not EDN (no parser dependency).

## Decision C — `--all` ships as an owner-accepted **weakening**, warn-and-go but not silent

The owner overrides the field report: `approve --all` exists. It is a **weakening of the human-review
gate** — bulk approval taxes reading no less than a loop does — and this ADR says so plainly rather than
pretending the warning removes the risk. It is made as honest as it can be:

- **Warn-and-go** (owner's posture). TTY: warn + interactive `[y/N]`. Non-TTY: warn to stderr, then
  proceed (no `--yes` gate). The warning always prints.
- **The warning is honest.** It lists every page + tier, and its trust-implication text is **conditioned
  on the actual `--by` authority** — the policy admits machine authorities (`invariant`), so "a human
  read each" is only printed for a human authority.
- **No unseen bytes.** Each page's digest is captured **before** the warning; a page edited during the
  prompt no longer matches and is **refused**, not approved against bytes the reviewer never saw.
- **No silent downgrade.** A page whose digest can't be computed is **refused**, never approved hashless.
- **The log reveals the bulk.** Every event carries the `batch_id` (+ mode/size/index), so N bulk
  approvals are distinguishable from N separately reviewed ones — closing the field report's "nothing in
  the log will reveal that it changed."

`--all` bulk-approves only *approvable* items (`approve`/`reapprove`); a `resolve-conflict` or
`confirm-dependencies` item is excluded and named, so `--all` never canonizes a contested page or
silently confirms a dirty dependency.

## Decision D — a `canonical` page in an unresolved `contested` conflict is not fact

BUREAU.md says `contested` is not fact, yet `effective.mjs` previously treated a `canonical + contested`
page as effectively canonical. **Implemented:** a page whose conflict is `contested` is now **excluded
from the effective-canonical set** in the authoritative reader/cache surfaces — `engine/effective.mjs`
(→ the chamber queue, the review-queue model, and `recall`/query) and `fsck`'s `--materialize-pages`
`effective_status` cache — and instead surfaces as a `resolve-conflict` work item / needs-review. Blast
radius audited: the board **canvas tier** reads `liveFreshness.authority` (a separate projection that
does not carry conflict), and the board already surfaces every contradiction via the **Health page's
`contradiction` count** (ADR-0002's tier + Health split). So the canvas tier is left as an acceptable
orthogonal display — the reader surfaces that decide "is this fact" exclude contested, and the board
flags the contradiction on Health — rather than threading conflict into a third projection. A dedicated
canvas contested-flag remains an optional display refinement, not a correctness gap.

## Rejected options

- **A *silent* `--all`.** Rejected — the warning always prints and every event carries `batch_id`;
  "warn-and-go" is warned and logged-as-bulk, not silent.
- **Refuse non-TTY `--all` for a human authority** (the critique's recommendation). Rejected by the owner
  in favor of warn-and-go; the residual scripted-bulk-approve risk is accepted and made auditable.
- **A flat "pending" queue.** Rejected — it drops dependency-dirty canonical pages and can't represent
  multi-partner conflicts.
- **"Atomic" batch that leaves a crash prefix.** Rejected as dishonest — the contract is commit-gated.
- **EDN manifests.** Rejected — JSON, for dependency hygiene.
- **CLI-only.** Rejected — the review skill, chamber, and BUREAU policy consume the same model.

## Consequences

- One `review-queue.mjs` model backs the CLI (`review --next`), the chamber, and the review skill.
- New log event types `batch-begin` / `batch-commit`; the decision projection learns to ignore
  uncommitted batches (a bounded projection change, verified against snapshot digests).
- `--all` is documented in BUREAU.md as a weakening; its events are self-identifying via `batch_id`.
- Excluding `contested` from effective-canonical (Decision D) changes board/queue/materialize output for
  any page in an unresolved contradiction.
