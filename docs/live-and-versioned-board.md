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
browser on every save** — painting the recursion engine's live state directly onto the gazette.

### The Engine view — one place, three signals

The Health page opens with an **"Engine · live state"** section: the three dynamic, dependency-aware
signals together, distinct from the deterministic *structural* checks below it. Each keeps its own
honest scope:

1. **Freshness (page↔page)** — the *"Drift · engine"* facet. Which page rests on an upstream claim
   that changed. Per-page badges ride here too: `needs-review` (amber), `stale` (red), `modified`
   (blue); a `current` page is unbadged. Badges reflect the **working tree** — they show an
   uncommitted edit *before* you `scan`, so a changed upstream lights up its dependents live.
2. **Artifacts (claim↔file)** — the *"Artifacts · currency"* facet. bureau can fingerprint the real
   file a claim was verified against (`ledger verify --artifact`); this re-hashes each against the
   working tree and flags any that **DRIFTED** — the one place the canon touches the repository and
   can silently rot. A drifted page also carries a **⚠ drifted** chip; a checked-and-current one a
   quiet **✓ current** chip.
3. **Convergence (trend)** — the *"Convergence"* facet. A replay of the decision log answering *is
   the canon settling or thrashing?* (`drained` / `stabilizing` / `thrashing`), with the queue depth,
   repeated firings, and cutoff ratio printed beside the verdict — never alone.

The terminal prints the freshness tally on each rebuild: `drift ⚠ 1 need review · 1 modified · 1
unscanned`.

The board previews; **`scan` records.** Freshness reflects your working tree in real time, but the
persisted state (the decision log) only advances when you actually run `gazette scan` (which appends
the edit events). A broken/tampered log degrades to no badges plus a surfaced integrity warning — it
never fails the build.

---

## Versioned board (git-backed)

A git commit already bundles a consistent `{pages + _log.jsonl + ledgers}` — so **the commit is the
snapshot unit.** No separate store; git holds content history, the decision log holds state history.

> **Git history is not a backup.** The commit is the snapshot *unit*, but a single local repo lives on
> one disk. Real durability needs a tested, offsite/encrypted backup of the workspace — a local mirror
> is only fast recovery, never the durable copy. See `docs/adr-0003-external-workspace.md` (Decision E).

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
| watch the live Engine view (freshness · artifacts · convergence) update as you edit | `serve` (the live board) |
| see the current dirty set without a browser | `gazette gate` / `bureau:status` |
| check whether a claim's verified file drifted | the Engine view, or `gazette ledger recheck` |
| look at the canon as it was at a past commit | `build --at <ref>` |
| see exactly what changed between two versions | `diff <A> <B>` |
| pin a reproducible "release" of the canon | `snapshot create <name>` |

The honest split: **git owns content history** (byte-level past boards), **the decision log owns
state history** (what changed, which decisions, which drift) — composed, never duplicated.

---

## External workspaces (ADR-0003)

When the canon lives OUTSIDE a public code repo (`~/bureaus/<name>/canon`, resolved per-machine via
`.bureau-id` + a user-local mapping), two things change — and one thing does **not**.

### Provenance is a cross-repo reference, not a bundle

The "commit bundles the evidence" property holds **within the knowledge repo**: a canon commit still
bundles `{pages + _log.jsonl + ledgers}`, so `build --at` / `diff` / `snapshot` work exactly as
above. What it does **not** bundle is the *code* the knowledge describes — that now lives in a
separate repo. So capture stamps a **descriptive** link on each minute:

```yaml
code_head: 4fa64993…      # the code repo's HEAD at capture time
code_dirty: true          # the working tree had uncommitted changes
```

Treat this as a pointer, not a reproducibility guarantee: a bare SHA is meaningless on a dirty tree
and can become unreachable after a rebase. It says "this minute was taken against roughly this code
state" — an explicit cross-repo reference, never a claim that one commit holds the complete evidence.

### Backing up & restoring — the drill

`~/bureaus/<name>` is the sole copy of your private canon. A second **local** git repo is a separate
deletion domain, **not** a backup. Real durability is a **private remote** (a private git host) and/or
a tested offsite/encrypted backup. Verify it with an actual restore drill:

```bash
# the workspace repo has a PRIVATE remote (never the public code host)
cd ~/bureaus/<name> && git remote -v

# simulate loss of the working copy, then restore from the private remote / backup
mv ~/bureaus/<name> ~/bureaus/<name>.gone
git clone <private-remote-or-backup-url> ~/bureaus/<name>

# re-pair this machine, then confirm the engine rebuilds to a clean fixpoint
node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.mjs" "<id>" "~/bureaus/<name>/canon"
node press/bin/gazette.mjs fsck --dir ~/bureaus/<name>/canon      # must report a stable fixpoint, 0 blocking findings
```

If `fsck` is clean after the restore, your backup is real. Do this drill periodically — a backup you
have never restored is a hope, not a backup.
