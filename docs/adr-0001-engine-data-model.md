# ADR 0001 — the recursion-engine data model

**Status:** accepted · **Date:** 2026-07-17 · **Lineage:** the internal planning docs
`dev-docs/roadmap-recursion-engine.md` §2/§5 and `dev-docs/implementation-plan-recursion-engine.md`
WI-0 (not shipped — this ADR is the committed record).

This ADR freezes the three schemas the recursion engine (`press/src/engine/`) is built on, and is
self-contained. Decisions A (engine location) and B (on-disk grammar) are ratified here.

## Decision A — engine location

The engine lives at **`press/src/engine/`**, exposed through new `gazette` subcommands, sharing the
one parser (`press/src/core/parse.mjs`) and the one bundle (`press/bin/gazette.mjs`). The renderer
stays a **pure consumer** of engine output; no renderer code writes the decision log.

## Decision B — on-disk grammar

- **Identity.** A page carries an authored, opaque, immutable `id:` (ULID). Title and path are
  mutable aliases. When `id:` is absent (pre-migration corpus), the loader derives a stable shim
  `uid = "t:" + nfc(title)`; a rename would change a *shim* uid, so rename-stability is only
  guaranteed once a real `id:` is authored (WI-10 stamps them). The renderer continues to resolve
  links by title; the engine keys everything by `uid`.
- **Spans.** A cited span is an author-anchored `^anchor` block marker in the body. The span's
  content (for hashing) is the contiguous non-blank line block terminating at the anchor line, with
  the `^anchor` token removed. Anchors are never heading text or line numbers.
- **Object edges.** `rests_on` accepts `string | { page, span, because }` list items. A bare string
  is `untracked` (recorded, treated `needs-review`, excluded from the sound-gate guarantee). The
  object form uses a **bounded inline-flow map** — a single-line `{ key: "value", … }` — the only
  nested shape the parser accepts; any other nested/mapping construct still throws.

## Schema 1 — decision log (append-only JSONL, `<workspace>/_log.jsonl`)

One JSON object per line. `seq` is monotonic (1-based); append is the only concurrent-safe
primitive; the log is the serialization point.

```jsonc
{ "seq": 1, "type": "introduce", "id": "<uid>", "span": "^a", "hash": "<sha256>" }
{ "seq": 2, "type": "edit",   "id": "<uid>", "span": "^a", "hash": "<sha256>", "prev": "<sha256>" } // bumps span_revision
{ "seq": 3, "type": "rename", "id": "<uid>", "from": "Old title", "to": "New title" }
{ "seq": 4, "type": "split",  "id": "<uid>", "from": "^a", "into": ["^a1","^a2"] }
{ "seq": 5, "type": "delete", "id": "<uid>", "span": "^a" }
{ "seq": 6, "type": "confirm-edge", "edge": "<edge-id>", "verdict_key": "<digest>", "by": "scan|human" }
{ "seq": 7, "type": "approve","id": "<uid>", "to_trust": "canonical", "by": "<user>" }
{ "seq": 8, "type": "reject", "id": "<uid>", "reason": "<str>" }
{ "seq": 9, "type": "resolve","conflict": "<a×b>", "winner": "<uid>", "resolution_id": "<seq>" }
```

- `ts` (ISO timestamp) is **optional and excluded from the fixpoint** — it is transaction-time
  metadata, not part of any derived-state computation (keeps `fsck` clock-independent).
- **`span_revision(uid, span)` = count of `introduce|edit` events for that `(uid, span)`.** A revert
  A→B→A produces `introduce(hashA)`, `edit(hashB)`, `edit(hashA)` → revision **3**, even though
  `hashA == hashA`. A monotonic identity, never a content hash.
- **Tamper rule:** the log is append-only. `fsck` recomputes a rolling digest over the lines; a
  rewritten past line breaks the chain and is reported.

## Schema 2 — verdict key (edge memoization)

```
verdict_key = sha256(canonicalJSON([
  target_uid, target_span, target_span_revision,
  dep_uid,    dep_span,    dep_span_revision,
  because_digest, schema_version
]))
```

`because_digest = sha256(because)`. Any component change ⇒ new key ⇒ the edge re-opens review. An
edge's `edge-id` = `sha256(canonicalJSON([dep_uid, dep_span, target_uid, target_span]))` (stable
across `because`/revision churn, so the log can track one edge over time).

## Schema 3 — frontmatter classes (§5 realized)

| Class | Keys | Written by | In fsck fixpoint? |
|---|---|---|---|
| **Authored** | `id` `title` `kind` `trust`(intent) `claim` `rests_on(+span+because)` `contradicts` `freeze` | human/agent | inputs |
| **Decided** | `trust: canonical`, `conflict`/`resolution_id` | decision log (projection) | inputs (via log) |
| **Mechanical-derived** | `freshness` `span_revision` edge verdict-keys backlinks dirty-marks (`_gate.json`) | code | **yes — byte-fixpoint** |
| **Ledgers (inputs)** | `_verify.json` (artifact fingerprints), `_compile-state.json` (compile watermark) | code (`engine/ledgers.mjs`) | **no — inputs** |
| **LLM-derived** | `digest`, semantic-verdict candidates | model | **no** (deferred to 0.9) |

> **Ledgers are inputs, not fixpoint outputs.** `_verify.json` records filesystem artifact hashes
> and `_compile-state.json` records which sessions were compiled — neither is derivable from
> `(authored snapshot + decision log)`, so they are *authoritative inputs* the code maintains, not
> rebuildable derived state. `gazette fsck` **verifies they are well-formed** and never claims to
> rebuild them (correcting the earlier draft that filed them under mechanical-derived).

**Four orthogonal state fields** (never one overloaded `status:`):

| Field | Values | Source |
|---|---|---|
| `trust` | `proposed \| verified \| canonical` | authored (`proposed`/`verified`), `canonical` projected from an `approve` event |
| `freshness` | `current \| needs-review \| stale` | derived by the gate |
| `conflict` | `none \| contested \| resolved` (+ `resolution_id`) | projected from `resolve` events |
| `freeze` | `welded \| firm \| provisional \| thawed` | authored hint |

Back-compat: the loader reads `trust:` if present, else falls back to the legacy `status:` value, so
the pre-migration corpus keeps working until WI-10 rewrites it.

## Worked example — the revert (golden fixture for WI-4/WI-7)

```
scan 1: page P span ^c content "A" → introduce(^c, hash=H(A))         → span_revision 1
scan 2: P/^c content "B"           → edit(^c, hash=H(B), prev=H(A))   → span_revision 2
scan 3: P/^c content "A"           → edit(^c, hash=H(A), prev=H(B))   → span_revision 3
```

A downstream edge `rests_on {page: P, span: ^c}` sees `target_span_revision` 1→2→3; its verdict key
changes at every scan, so it re-opens review each time — including the revert. A content hash alone
would show `H(A) == H(A)` at scan 3 and miss the churn; the revision counter does not.
