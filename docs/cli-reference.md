# `gazette` CLI reference

The bundled press ships a single self-contained Node binary — no `node_modules`, Node ≥ 18. bureau
runs it for you (`bureau:inspect`, `bureau:serve`, `bureau:cycle`, …), but you can call it directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" <verb> [flags]
# in a checked-out bureau repo, from the repo root, it's on your path as the vendored bundle:
node press/bin/gazette.mjs <verb> [flags]
```

### Common flags

| flag | meaning |
|---|---|
| `--dir <dir>` | the content dir. **Omitted:** the render/engine verbs auto-detect a bureau workspace (a single `*/bureau.json` child of the cwd) and use it; otherwise the press default `gazette/`. `--dir` always wins. (`--docs` is a legacy alias.) |
| `--data <dir>` | data dir for generated views (default `<dir>/_data`) |
| `--out <dir>` | output dir (default `dist/`) |
| `--now YYYY-MM-DD` | staleness baseline (default today); a bad value fails loudly |

---

## Setup & dev

| command | does |
|---|---|
| `gazette init` | scaffold a sample `gazette/` (the press's own starter) + `.gitignore dist/`. *(For a bureau workspace use `bureau:init` instead.)* |
| `gazette serve [--port 8080]` | build once, serve `dist/` on localhost, watch the content dir, rebuild + **hot-reload** on every save — the **live freshness board** |
| `gazette new <folder>/<slug> ["Title"]` | create a new doc under the content dir |

## Build & view

| command | does |
|---|---|
| `gazette build [--out --now]` | one-shot build → `dist/` (a shareable offline artifact); reports doc count, health, and the live drift tally |
| `gazette build --at <ref\|snapshot> [--out]` | render the board **as of** a git commit or named snapshot (via a detached worktree); default output is `dist-at-<commit>` so it never clobbers the live board |
| `gazette open` | build, then open `dist/index.html` |
| `gazette watch` | rebuild on save (no server) |

## Maintain (structural, deterministic)

| command | does |
|---|---|
| `gazette audit` (alias `health`) | deterministic check: dangling / orphan / contradiction / invalid-date / schema / drift / stale / unsourced. Non-zero exit on findings (CI-friendly). |
| `gazette doctor [--apply]` | audit → a repair plan; `--apply` fixes the safe subset |
| `gazette rename "<old>" "<new>" [--dry]` | rename a doc and propagate every reference |

## Recursion engine (dependency-aware freshness)

See [`recursion-engine.md`](recursion-engine.md) for the model.

| command | does |
|---|---|
| `gazette scan [--dry]` | reconcile the decision log with the corpus — append introduce/edit/delete span events. `--dry` computes without writing. |
| `gazette gate` | the eager dirty index: `needs-review`/`stale` pages + the cutoff ratio *beside* the edge count |
| `gazette impact "<title>"` | pre-change blast radius — which pages (transitively) rest on this one, so you see the review cost before editing its claim |
| `gazette fsck [--check]` | rebuild the derived tier to a byte-fixpoint; non-zero exit on a broken fixpoint, tampered log, or a blocking finding (unbacked-canonical, orphan-confirm, malformed ledger). `--check` doesn't write the cache. |
| `gazette report` | deterministic auditable metrics: fixpoint digest, gate accounting (cutoff ratio beside edge count), wiring kill rate |
| `gazette telemetry` | convergence telemetry (§4.14): replays the decision log to show per-run work, repeated firings, review-queue depth + age, and a `drained`/`stabilizing`/`thrashing` verdict — the *trend*, where `gate`/`report` are point-in-time. Read-only, always exit 0. |
| `gazette approve "<title>" [--by <who>]` | log a human approval → backs `trust: canonical` |
| `gazette reject "<title>" [--reason "…"]` | log a rejection (the authored tier stands; no canonical backing) |
| `gazette confirm "<title>" [--by <who>]` | vouch that a dependent page's open `rests_on` edges still hold → cutoff (skips broken edges) |
| `gazette resolve "<A>" "<B>" --winner "<title>"` | record which side of a `contradicts` conflict wins |
| `gazette ledger verify --page "<title>" --artifact <path> [--claim "…"]` | fingerprint an artifact under a page (path-jailed to the repo) |
| `gazette ledger recheck --page "<title>"` | re-hash a page's recorded artifacts; reports `current`/`DRIFTED` |
| `gazette ledger mark-compiled <session-id> …` | record processed sessions (idempotent) |
| `gazette ledger uncompiled <session-id> …` | print which of the given sessions aren't yet compiled |

## Versioned board (git-backed)

See [`live-and-versioned-board.md`](live-and-versioned-board.md).

| command | does |
|---|---|
| `gazette build --at <ref\|snapshot>` | render any past board (above) |
| `gazette diff <A> <B>` | what changed between two versions — the decision-log slice (span edits, decisions) + `_verify.json` artifact drift (added/removed/changed) |
| `gazette snapshot create <name> [--note "…"]` | pin a named, reproducible version `{commit, log-seq, fsck digest}` (refuses a dirty source tree) |
| `gazette snapshot list` | list pinned snapshots |

---

## On-disk artifacts

| path | class | committed? |
|---|---|---|
| `<workspace>/*.md`, `_config.json`, `bureau.json` | **source** | yes |
| `<workspace>/_log.jsonl` | **source of truth** (decision log; tamper-evident) | yes |
| `<workspace>/_verify.json`, `_compile-state.json`, `_snapshots.json` | **decision inputs** (trust ledgers, snapshot manifest) | yes |
| `.bureau-cache/` (repo-root sibling) | **derived** gate cache (regenerable by `fsck`) | **no** (gitignored) |
| `<board>/` (default `gazette/`) | **derived** rendered board | **no** (gitignored) |
| `dist-at-<commit>/` | **derived** historical board | no |

The workspace holds only source + committed decisions; everything derived lives outside it.
