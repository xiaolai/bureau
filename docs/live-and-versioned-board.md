# The live & versioned board

The gazette is a rebuilt snapshot of your canon. Two features make that snapshot *dynamic* — a
**live** view that updates as you edit, and **versioned** views that render, diff, and pin any point
in history. Both are local and offline; neither adds a store — git is the version store, the
decision log is the change stream.

---

## Live freshness board

```bash
node press/bin/gazette.mjs serve        # or: bureau:serve
```

`serve` builds the board, serves it on localhost, watches the workspace, and **hot-reloads the
browser on every save** — and it paints the recursion engine's **freshness** onto the board:

- **Per-page badges** — `needs-review` (amber), `stale` (red), `modified` (blue). A `current` page
  is unbadged. The badge reflects the **working tree**: it shows an uncommitted edit *before* you
  `scan`, so a change to an upstream claim lights up its dependents live.
- **A "Drift · engine" section** on the Health page — the *why* behind each badge (which upstream
  span changed), distinct from the coarse timestamp-based `Stale` lane.
- The terminal prints the tally on each rebuild: `drift ⚠ 1 need review · 1 modified · 1 unscanned`.

The board previews; **`scan` records.** Freshness reflects your working tree in real time, but the
persisted state (the decision log) only advances when you actually run `gazette scan` (which appends
the edit events). A broken/tampered log degrades to no badges plus a surfaced integrity warning — it
never fails the build.

---

## Versioned board (git-backed)

A git commit already bundles a consistent `{pages + _log.jsonl + ledgers}` — so **the commit is the
snapshot unit.** No separate store; git holds content history, the decision log holds state history.

### Render any past board

```bash
node press/bin/gazette.mjs build --at <ref|snapshot>     # e.g. --at HEAD~5, --at v1.2, --at rc
```

Checks out that commit into a throwaway git worktree, renders it, and cleans up. Output defaults to
`dist-at-<commit>/` so it never overwrites your live board. The `--out` target is guarded against the
live content/data dirs and the repo root — a historical build can't clobber source.

### Diff two versions — semantically

```bash
node press/bin/gazette.mjs diff <A> <B>
```

Reads the decision-log slice between the two commits (requiring B to be an append-only extension of
A — a divergent or reversed pair is rejected, not silently mis-reported) and prints **what changed**:

```
diff v1 (a1b2c3d4, seq 8) → HEAD (e5f6a7b8, seq 12): 4 new log event(s)
  edit ×2: pg-adr-0001 ^decision, pg-glossary ^lexicon
  approve ×1: pg-adr-0001
  confirm-edge ×1: edge 1bed2048
  artifact-drift (changed): [Build command] → package.json
```

That's a *semantic* changelog — span edits, approvals, confirmations, resolutions, and artifact
fingerprint drift (added / removed / changed) — from the source of truth, not a text diff.

### Pin a named snapshot

```bash
node press/bin/gazette.mjs snapshot create v1.0 --note "first reviewed canon"
node press/bin/gazette.mjs snapshot list
```

Records a reproducible pin `{commit, log-seq, fsck digest}` in `<workspace>/_snapshots.json`
(committed). A snapshot describes a *commit*, so it refuses a dirty source tree — commit first. A
snapshot name then works anywhere a ref does: `build --at v1.0`, `diff v1.0 HEAD`.

---

## Which surface for what

| you want to… | use |
|---|---|
| watch freshness update as you edit | `serve` (the live board) |
| see the current dirty set without a browser | `gazette gate` / `bureau:status` |
| look at the canon as it was at a past commit | `build --at <ref>` |
| see exactly what changed between two versions | `diff <A> <B>` |
| pin a reproducible "release" of the canon | `snapshot create <name>` |

The honest split: **git owns content history** (byte-level past boards), **the decision log owns
state history** (what changed, which decisions, which drift) — composed, never duplicated.
