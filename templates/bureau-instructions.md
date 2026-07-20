---
description: The trust-gate rules binding every AI session in this repo — consult the canon before deriving, honor each claim's tier on read, and route every durable write through capture → compile → review.
---

# bureau — durable knowledge for this repo

**Consult the canon before you derive; honor each dossier's trust tier on every read; route every
durable write through the gate — never set `canonical` by hand.**

This repository keeps its durable knowledge in a **bureau** workspace (`{{WORKSPACE}}/`): topic
**cabinet** pages (the reviewed canon) plus an append-only **logbook**. `CLAUDE.md` imports this
file, so the gate below binds **every** session here — honor it whenever you read or write
knowledge in this repo.

## Reach for the canon first

- Before deciding something this repo may have already settled (an architecture choice, a
  convention, a prior call), **consult the canon first** — `bureau:query` — instead of re-deriving
  or guessing. The answer may already be recorded, with its trust tier.
- When a session produces something durable (a decision, a constraint, a resolved question),
  **capture it** — `bureau:note` during the session, or `bureau:file-session` to file the whole
  session — before it ends. Capture is cheap; lost context isn't.

## Honor the trust tier on read

Every cabinet page carries a `status:`. When you use one as memory or context, **honor it**:

- `canonical` — an authority the active `trust_policy` accepts approved it → treat as **fact**, and
  **cite the backing authority with the tier** (`canonical · by human` / `· by invariant`). Under the
  default human-only policy that authority is a human; under a policy accepting a machine class it is
  not, and a machine-backed claim does not carry human-level confidence. The engine recognizes an
  authority *class*, never an authenticated identity.
- `verified` — auto-checked against the repo, not yet approved → usable, but reconfirm if it is
  load-bearing.
- `proposed` / `stale` / `contested` — **NOT fact** → verify before relying, and state which tier
  you are leaning on.

Never silently treat a non-`canonical` claim as settled. The tier travels with the claim; if you
cite a cabinet fact, cite its tier too. `bureau:query` enforces this for you.

## Respect the write gate

Never write a durable claim straight into the canon, and never set `canonical` yourself — and do
not hand-edit cabinet pages. Memory is gated: **capture** (it lands in the low-authority logbook) →
**compile** (into cabinet pages as `proposed`/`verified`) → **review** (a human promotes to
`canonical`). The logbook is append-only — never rewrite a past entry.

**You (an AI session) MUST NOT invoke the human-authority decision commands.** That means never
running `gazette approve`, `gazette confirm`, or `gazette resolve` (nor `bureau:review`'s
promote/confirm/resolve steps) on your own initiative, and never passing `--by human`, a person's
name, or omitting `--by` so the event is recorded as human. The authority on a decision event is a
**claim the writer asserts, not an authenticated identity** — the log is tamper-evident, but nothing
stops a caller from writing `by: "human"`. The whole gate rests on you not doing that. Surface what
is ready for decision and let the human run it; if you are driving an automated pipeline, record it
under its real machine authority (`--by invariant`) and let `trust_policy` decide whether it counts.

## Cite the minute that introduced the claim

Every cabinet claim links back to the minute that introduced it. **Provenance is a `[[wiki-link]]`
to a minute** — that is what makes it an edge the press can index and a backlink the minute can
show. The convention `bureau:compile` writes is a **body** line:

```markdown
**Sources.** [[session a1b2c3d4 · 2026-06-10]]
```

- A frontmatter `sources:` list of `[[wiki-links]]` **also** counts — it becomes a typed edge and
  a real backlink, exactly like the body line. Prefer the body line (one shape, and it's what
  compile writes), but either is genuine provenance.
- What is **not** provenance is a **plain string**: `sources: ["session 978074e1 (RT-03 pilot)"]`
  is prose, not a link — no edge, no backlink. Wrap the target in `[[ ]]`.
- Cite the **minute**, not the drawer: linking `[[Logbook]]` is not provenance for a claim.
- A tiered page with no provenance link is reported as **unsourced** by `gazette health`.

Frontmatter grammar: flat `key: value` lines, inline lists (`tags: [a, b]`), and multi-line lists
of scalars. Values are always strings — no YAML type coercion. Nested maps and block scalars
(`|`, `>`) are rejected outright. The **one** nested exception is a `rests_on` object edge, written
as a bounded single-line inline map — `{ page: "[[Target]]", span: "^anchor", because: "…" }`.

## The recursion engine — declare dependencies, don't memorize

A cabinet claim that rests on another page's claim should **declare it**, so a change upstream
mechanically flags the downstream for review instead of rotting silently. This is the deterministic
dependency gate:

- **Identity is an opaque `id:`** (frontmatter), not the title. Titles/paths are mutable aliases; a
  rename never changes identity. Do **not** reuse or hand-change a page's `id:`.
- **Anchor the cited claim with a `^anchor`** at the end of its line (an author-anchored *span*).
  A downstream page cites it: `rests_on: - { page: "[[Upstream]]", span: "^anchor", because: "…" }`.
  An edge with a `span` is **tracked** (gated); a bare `rests_on: "[[X]]"` string is **untracked**
  (conservatively `needs-review`, outside the sound-gate guarantee).
- **State is four orthogonal fields**, projected/derived — never one overloaded `status:`:
  `trust` (proposed/verified/canonical), `freshness` (current/needs-review/stale, derived by the
  gate), `conflict` (none/contested/resolved), `freeze` (a change-priority hint). The legacy
  `status:` still works — the loader reads it as `trust` when `trust:` is absent.
- **The decision log is the source of truth.** `canonical` is a **projection** of a logged
  `approve` event, not the frontmatter alone — `gazette fsck` flags any authored `canonical` no
  approval backs. Never hand-edit `{{WORKSPACE}}/_log.jsonl`; it is append-only and tamper-evident.
- **Who may approve is policy.** `canonical` is backed by an `approve` event whose *authority* the
  workspace accepts (`_config.json` → `trust_policy`; the default is human-only). Under a policy
  that accepts a machine authority, `canonical` no longer implies a human vouched — so cite the
  backing authority beside the tier, and treat an `unauthorized-canonical` finding as **not** settled.
- **Mechanical, code-owned** (never hand-write) — run the bundled press,
  `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" <verb> --dir {{WORKSPACE}}`:
  `scan` (record span-revision events after edits), `gate` (the eager dirty index — a page's real
  freshness), `fsck` (rebuild derived state to a byte-fixpoint; a CI gate), `report` (auditable
  metrics), `approve`/`confirm`/`resolve "<title>"` (the human side of the log), and
  `ledger …` (the `_verify.json` / `_compile-state.json` trust ledgers).
- **Live board.** `gazette serve --dir {{WORKSPACE}}` renders the gate's freshness onto the board and
  hot-reloads on every save — a page that sits on a changed upstream span shows a `needs-review`
  badge (and a "Drift" section on the Health page) *before* you `scan`, reflecting the working tree.
- **Versioned board (git-backed).** A git commit bundles `{pages + _log.jsonl + ledgers}`, so it is
  the snapshot unit: `gazette build --at <ref|snapshot>` renders any past board, `gazette diff <A>
  <B>` reports what changed from the decision-log slice, `gazette snapshot create <name>` pins a
  named `{commit, log-seq, digest}` (committed in `_snapshots.json`).
