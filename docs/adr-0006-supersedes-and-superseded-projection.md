# ADR-0006 — `supersedes` edges and the `superseded` projection (an ADR-native layer)

**Status:** proposed (committed once the ADR layer in `dev-docs/adr-layer-plan.md` settles).
**Date:** 2026-08. **Extends:** ADR-0004 (content-bound trust, projection-only), ADR-0005 (review
ergonomics), ADR-0002 (canvas projection — the board view).

**Sources.** A period of using bureau as an ADR system for agents, a borrow-list from adr-tools /
Log4brains / MADR, and a two-fork Codex design review of the implementation plan (recorded below where
it changed the design).

## Context

After sustained use, bureau turns out to be a strong substrate for **agent-authored Architecture
Decision Records**: an un-forgeable human acceptance gate, content-bound approvals, dependency-staleness
re-flagging, and session provenance are exactly what an ADR wants and what plain ADR-tools lack. What was
missing was a thin ADR-native layer: a way to say "this decision **supersedes** that one," a state for a
decision that has been superseded, a scaffold command, and a decision-focused board view — *without*
weakening any of the ADR-0004/0005 guarantees the value rests on.

The load-bearing risk is the temptation to let an AI-written supersession silently retire a decision no
human re-read. This ADR is mostly about **not** doing that.

## Decision A — `supersedes` is a plain typed edge; the reverse link is derived

`supersedes: "[[ADR-000N …]]"` is an ordinary typed frontmatter edge, exactly like `contradicts` — it is
not in the reserved key set, so `parse.mjs`'s generic `addRel` yields `{target, edgeType:"supersedes"}`
with **no parser change**. It does **not** use the `rests_on` span/because machinery (a supersession is a
whole-decision relation, not a claim-level dependency). The reverse "superseded-by" link is a **derived**
inbound edge from `deriveBacklinks` (which inverts all edges) — never hand-written into the target, which
would be a forbidden hand-edit and would void content-binding. A comma list supersedes two-plus targets,
mirroring the `contradicts` grammar.

## Decision B — `superseded` is a projection-only, `fsck`-level state

Trust/status is a projection of the decision log (ADR-0004 Decision C); `superseded` is likewise
**projected, never authored**. Crucially it lives in **`fsck()`**, beside `stale-approval`/`contested`,
**not** in the byte-fixpointed `buildDerived` tier — because (Decision C) it depends on raw-byte
freshness, which `buildDerived` (pure over `(model, events)`) does not see. Consequences:

- `buildDerived` is **left untouched**, so the derived digest is **byte-identical by construction** — a
  corpus with no *effective* supersession projects the exact pre-feature bytes. There is no
  conditional-emit gymnastics inside `decided[]`; the byte-fixpoint risk collapses to "`buildDerived`
  unchanged," locked by a committed literal-digest test.
- `superseded` is exposed as `report.superseded: Map<targetUid, [supersedingUids]>`, and the superseded
  uids are added to `fsck`'s existing `notEff` set — so they are excluded from the effective-canonical
  set **and** the `--materialize-pages` cache through the *one* shared path (no second, drifting copy).

## Decision C — effectiveness gates on the superseding ADR's **fresh** approval (Codex fork 1)

A `supersedes` edge M→N is **effective** (N is actually superseded) iff M's approval is **content-current**
— M is in `decisions.approved` **and** its approval hash still matches `reviewDigest(M)` (M is not
`stale-approval`, and not a hashless/unbound approval). Mere presence in `decisions.approved` is **not**
enough.

Rationale (the review's decisive finding): readers reconstruct canonical state from `effective.mjs`'s
explicit exclusions, **not** from `fsck.ok`. So gating on mere approval would let an edge *added to M after
its approval* — unreviewed content — silently demote N for every reader, even while `fsck` blocks. That is
precisely the loophole content-binding exists to close. Gating on fresh approval keeps supersession inside
the same content-bound guarantee as every other canonical claim. A hashless (legacy, unbound) approval is
**fail-closed**: it cannot activate a supersession until re-approved with a bound hash.

The residual coarseness — any edit to M briefly *un-supersedes* N until M is re-approved — is identical to
how every canonical claim behaves under content-binding, so it is consistent, not surprising.

## Decision D — a supersedes edge demotes only a **decision** target (Codex fork 2)

Supersession is a relation between *decisions*. N is marked `superseded` only if it is, in the
**pre-supersession** effective-canonical set, an eligible target: effectively `canonical` **and**
uncontested. Computing eligibility from the pre-supersession set breaks the circularity
(superseded → eligibility → effective-canonical → superseded) and lets `contested` win cleanly. For an
**ineligible** target (a still-`proposed`/`stale`/`contested` N): the edge is recorded (the backlink still
shows), but N is **not** marked superseded, **not** removed from the review queue, and a
`supersedes-ineligible-target` **advisory** finding explains why. This keeps *withdrawal of a proposal*
and *conflict resolution* as their own workflows, and avoids a blocking `fsck` whose remediation item has
vanished from the queue.

## Decision E — findings and their grading

`fsck` emits, over the fresh-approved supersession graph:

| Finding | Grade | Meaning |
|---|---|---|
| `supersedes-cycle` | **blocking** (`fsck.ok=false`) | An effective supersession cycle (A supersedes B supersedes A) is a real contradiction. Computed over **effective (fresh-approved-source) edges only**, so an inert/unapproved cycle never blocks the CI gate. Self-loops are degenerate cycles. Cycle members are fail-closed (never marked superseded). |
| `broken-supersedes` | advisory | A `supersedes` pointing at a since-deleted page — a dangling-link authoring issue. |
| `supersedes-ineligible-target` | advisory | A fresh-approved M supersedes a non-decision target (Decision D). |

## Decision F — readers: excluded from fact, **not** flagged for review, positively surfaced

`effective.mjs` reads `report.superseded` and: **excludes** those uids from `canonical`; does **not** add
them to `needsReview` (a superseded page is settled history, not pending work — the opposite of
`contested`); and returns a **positive** `superseded` surface (`{uid, status:"superseded", supersededBy}`)
so `query`/`recall` say "superseded by M" instead of silently omitting N. `reviewQueue().baseKind()`
returns `null` for a superseded uid — but only an **eligible** one; an ineligible target keeps its normal
work item. No new work-item kind is introduced: a supersession is activated by approving the superseding
ADR through the existing `approve` item.

**The NL reader surface.** The NL reader skills (`bureau:query`/`recall`) detect effective tier from the
materialized `effective_status:` cache, not the in-process `report.superseded`. So `fsck --materialize-pages`
also writes a derived **`superseded_by:`** marker (a **plain-string** title list — never a `[[wiki-link]]`,
which would mint a phantom edge; and in `reviewDigest`'s `NON_SEMANTIC_KEYS`, so it never invalidates an
approval). It is authoritatively rewritten/removed, so a stale or hand-spoofed value cannot survive a
materialize. For **parity with `effective_status`** — whose staleness is caught by `unbacked-canonical` —
a page carrying a `superseded_by:` marker that is not actually superseded raises an advisory
**`stale-superseded-marker`**, so a reader that cross-checks `fsck` never trusts a stale marker. Reader
caveat: like `effective_status`, the marker only appears where a workspace runs `--materialize-pages`
(which `recall` invokes and the board does); without it, a superseded page is still excluded from *fact*,
just not positively labelled. The review-queue also carries the `supersedes` target on the superseding
ADR's `approve` item so every surface warns "approving this retires <target>".

## Decision G — the authoring surface stays inside the gate

`gazette adr new` / `bureau:adr` scaffold a **`proposed`** MADR page (`kind: adr`, six sections:
Context · Decision Drivers · Considered Options · Decision Outcome · Consequences · Confirmation),
auto-numbered (`nextAdrNumber` = max+1 over the workspace's ADRs), with an optional single-line
`supersedes` edge resolved from an `ADR-N` token to the target's title. The verb **authors a source file
only**: it never touches `_log.jsonl`, never approves, never passes `--by`; the write is jailed + atomic
(`O_CREAT|O_EXCL|O_NOFOLLOW`). An ADR — and any supersession it declares — becomes fact only when a
**human** approves it via `bureau:review`. The scaffold's **Confirmation** section names a
`gazette ledger verify` command so a drifted confirming artifact re-flags the ADR via the existing
artifact-currency machinery (chip + Health view + `ledger recheck`) — no new engine code.

## Decision H — a decision-filtered board view (reusing the renderer)

`deriveLayout` preserves `edgeType`/`tracked` **additively** (the default renderer ignores them, so the
main Graph SVG is byte-identical). A generated **Decisions** section renders the ADR subgraph only
(`kind:adr` nodes + `supersedes`/`rests_on` edges between them), styling `supersedes` distinctly (dashed +
typed class) and greying effectively-superseded nodes. It is emitted **only** when the workspace has ADR
pages. The SVG is regenerable output, never in the fsck fixpoint (ADR-0002).

## Consequences

- **Good.** Supersession inherits every ADR-0004 guarantee: an AI cannot retire a decision; a
  post-approval edit inertly reverts it until re-review; the byte-fixpoint is untouched; the materialize
  cache and readers agree through one path. bureau becomes a content-bound, provenance-carrying ADR system
  better than plain ADR-tools on the axes that matter to agents.
- **Bad / accepted.** The coarse un-supersede-on-edit (Decision C); `_verify.json` is title-keyed, so a
  renamed ADR loses its Confirmation chip (documented, mitigated by the stable `ADR-NNNN` prefix).
- **Neutral.** No new decision-event verb, no new review-queue kind, no `approve`/`confirm`/`resolve`
  authority change — the ADR layer consumes the ADR-0004/0005 gate, it does not alter it.

## Rejected / deferred

- **Mere-approval effectiveness** (Codex fork 1, losing side) — ships a content-binding hole; rejected.
- **Any-target supersession** (Codex fork 2, losing side) — hides a page that still needs a trust action;
  rejected.
- **A `reverify-artifact` review-queue kind** for a canonical ADR whose Confirmation drifted — deferred
  (a 6th kind is a review-queue model change); drift surfaces via the existing chip/Health view.
- **A dedicated `gazette supersede` decision-event verb** — supersession is a typed edge on a proposed
  page, activated by approving that page; no new verb.
- **Content-binding the supersession to the superseding ADR's current bytes beyond fresh-approval** — the
  fresh-approval gate (Decision C) already covers the exploit; no finer refinement is pursued here.
