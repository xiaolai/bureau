# ADR 0003 — external workspaces (private knowledge, public code)

**Status:** accepted (direction) · **Date:** 2026-07-29 · **Lineage:** an architecture discussion
plus a Codex (`gpt-5.6-sol`) red-team review that verified the defect below against the engine
source. The executable work-item plan lives in `dev-docs/implementation-plan-external-workspace.md`
(not shipped — this ADR is the committed record). Two sub-decisions remain open (§Open).

This ADR ratifies **where a bureau workspace may live** when the knowledge must not travel with the
code repo, and the one engine change that makes it sound. It is self-contained.

## Context — the requirement

A workspace default of `canon/` **committed at the code-repo root** is correct for a fully-private
repo, and that mode stays the default. But a recurring case is not served by it:

- the knowledge should **not sit at the repo root**;
- it often **must not be pushed to the public code remote** (private knowledge, public code);
- it should be **durable** — survive `rm -rf` / re-clone / `git clean` of the code tree;
- ideally **one place for all projects** (`~/bureaus/`);
- **automatic session capture must keep working.**

The tempting answer — a nested, gitignored `canon/` that is *its own* git repo inside the code
repo — is **wrong**, for a reason that is not obvious from the outside.

## The defect that kills the nested-in-tree scheme (verified)

The versioned-board commands derive the git repository from **`process.cwd()`**, not from the
workspace:

- `runBuildAt` / `runDiff` / `runSnapshot` set `root = process.cwd()` (`press/bin/cli.mjs:380,394,411`);
  `engineDir()` = `resolve(process.cwd(), contentDir())`.
- `repoObjectPath(root, absPath)` computes the workspace path *relative to the git top-level of that
  cwd* and **throws when `rel === ""`** (`press/src/engine/versions.mjs:29`).

Consequences for a nested, gitignored `canon/` inside a public code repo, invoked from the code root:

- git resolves the **outer** (public) repo; `/canon/` is ignored and absent from its commits;
- `build --at <ref>` cannot find the workspace at that commit;
- `diff` reads the outer repo's (absent) `_log.jsonl`;
- `snapshot` pins the **outer code HEAD**, not the canon HEAD;
- invoking from *inside* `canon/` does not save it — `repoObjectPath` rejects `rel === ""`.

Auto-capture would still work (it is cwd-contained and git-agnostic), but the entire git-native
engine — `build --at`, `diff`, `snapshot` — silently operates on the wrong repository. The nested
scheme is therefore rejected.

## Decision A — the layout: workspace is a child of its own git root

The external workspace lives at **`~/bureaus/<proj>/canon`**, where **`~/bureaus/<proj>/` is the git
root**. Because the workspace is a *child* of the root, `repoObjectPath`'s `rel !== ""` requirement
is satisfied and versioning works. A workspace that *is* the git top-level (`rel === ""`) is a hard
error with a message telling the author to nest it under a root.

## Decision B — version ops locate git from the workspace, not `cwd`

The one core engine change: `runBuildAt` / `runDiff` / `runSnapshot` derive the git root from the
**resolved workspace path** (`git -C <workspace> rev-parse --show-toplevel`), never from
`process.cwd()`. Everything else in Decision A depends on this.

## Decision C — selection by a user-local mapping, never a committed path

The workspace is resolved through a **user-owned** mapping — `~/.config/bureau/workspaces.json`,
`0600` — keyed by an **opaque** id. The code repo commits only `.bureau-id` (the id, **no path**).

A committed *path* would be attacker-controlled in a cloned repo: it could aim at another project's
workspace under `~/bureaus/` (whose `bureau.json` marker already exists), and the compaction hook
would read that logbook back into the active session — a **cross-project confidentiality path**, not
merely an unwanted write. So the committed file names *which* workspace; the user's own machine
decides *where* it is. Unmapped id ⇒ refuse to write and print an explicit pairing command (no
silent auto-map).

## Decision D — the security anchor moves from cwd-containment to mapping + pairing

The capture hook's current anchor is "never write outside `cwd`" (`scripts/capture-stub.mjs`).
External mode deliberately writes outside `cwd`, so the anchor moves to **user-local mapping +
explicit first-time pairing**. The *only* source of a filesystem target is the user's `~/.config`
file — never the untrusted payload, never a committed repo file. Required controls (all mandatory,
not optional): realpath both the allowlist root and the target, reject symlink components, require a
`bureau.json` marker at the target, require the target be owned by the current user with restrictive
permissions, and re-check at write time.

## Decision E — durability is a real backup, not a local mirror

A second local git repo (`~/bureaus/<proj>.git`, an earlier proposal) is a **separate deletion
domain**, not a backup. It survives deleting the checkout; it does **not** survive disk/machine loss,
filesystem corruption, ransomware, `rm -rf ~/bureaus`, or a push that omits refs/tags — and a local
clone may hardlink objects, so the two stores are not independent against object corruption.
**Durability = a tested, offsite/encrypted backup of `~/bureaus/`.** The local mirror is at most a
fast-recovery convenience and must never be counted as the durable copy.

## Consequences

- **In-repo mode stays the default** for private repos (canon committed to the same repo) — it
  already works and loses nothing. External mode is opt-in for public-code/private-knowledge and
  cross-repo cases.
- **Atomic code+knowledge provenance is given up** in external mode. A canon approval and the code it
  describes are no longer one commit; `_verify.json` still hashes artifacts, but the code tree is not
  recoverable from the canon commit. This is modeled as an **explicit cross-repo reference**, not
  pretended away. Capture stamps `code_head: <sha>` and `code_dirty: <bool>` as **descriptive**
  metadata — a bare SHA is misleading on a dirty tree and may become unreachable after a rebase, so
  it is not a reproducibility claim.
- **The internal trust gate is unaffected** — pages, `_log.jsonl`, policy, and ledgers still share
  the one *knowledge* commit.
- **Two documentation claims are corrected** as part of this work: `_log.jsonl` is
  **tamper-detecting for naive edits**, not attacker-proof (the hash chain is unsigned; a writer can
  recompute every `ic` — `policy.mjs:48` already calls authority an unauthenticated assertion); and
  no single local copy is called "durable."

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Nested, gitignored `canon/` as its own repo in-tree | Breaks `build --at`/`diff`/`snapshot` (Decision B defect); plus ripgrep/backup tools silently skip ignored trees, IDE dual-repo confusion, `git clean -ffdx` exposure |
| `~/bureaus/<proj>.git` local bare mirror as the durable copy | Not a backup (Decision E) |
| Committed `workspacePath` in `bureau.json` | Injection / cross-project leak (Decision C) |
| SHA-named tag on the canon repo as the code link | Redundant, collision-prone, does not preserve the code commit |
| Ignored plain `canon/` (not a repo) + file backup | Forfeits the whole git-native engine (no knowledge history at all) — acceptable only as a stopgap, with the version commands explicitly disabled |

## Open (tracked in the plan)

1. **Build the external mode now (plan Phases 1–5) or take the interim stopgap and defer.**
2. **Repo identity mechanism:** opaque committed `.bureau-id` (recommended — intentional, robust)
   vs. deriving identity from the code repo's root-commit SHA (no committed file, but fragile to
   shallow clones / rewritten root history).
