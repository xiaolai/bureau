# bureau

Turn AI sessions into a maintained, human-reviewed, **dependency-aware** canon.

Every AI session is an unrecorded meeting; natural-language docs drift, go stale, and contradict
each other. **bureau** turns sessions into memory you can trust:

- **Write, gated.** **Capture** each session to an append-only **logbook** → **compile** into
  consistency-checked **cabinet** pages (the SSOT, with provenance) → **review**, the human gate that
  promotes a claim to `canonical`. AI-written claims are never fact until you approve them — memory
  works like version control, not a notepad the AI scribbles in.
- **Track, mechanically.** Declare which claim *rests on* which (`rests_on` + author-anchored
  `^spans`), and a deterministic **recursion engine** flags every downstream page when an upstream
  claim changes — a hash gate decides *cheaply* whether it actually changed, a human decides whether
  it matters, and the verdict is memoized. No more silent staleness.
- **Read, tier- and freshness-aware.** **`query`** answers from the canon, citing each claim's trust
  tier *and* its freshness, refusing to state an unverified or stale one as fact. **`BUREAU.md`** —
  written by `init` at your repo root and imported from `CLAUDE.md` — makes *every* AI session honor
  those rules, so the gate governs all work, not just bureau commands.
- **Inspect, live & versioned.** A navigable offline **gazette** (the board), built by the bundled
  **press** — with a **live Engine view** (`serve`) that lights up as you edit: page↔page *freshness*,
  claim↔file *artifact currency* (a verified file that drifted), and the *convergence* trend, all in
  one place — plus **git-backed versioning** to render any past board, diff two versions, and pin
  named snapshots.

This is the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
(LLM as compiler, not retriever) plus session provenance, a review gate, an always-on `BUREAU.md`
instruction, and a deterministic dependency gate — so the canon is current, *traceable*, *trusted*,
and *self-maintaining*.

**New here?** Start with the **[docs](docs/README.md)** — a [User Guide](docs/user-guide.md) with a
60-second quickstart, and a guide to the [recursion engine](docs/recursion-engine.md).

## Trust tiers + freshness — why memory here is safe

The cabinets double as repo memory, and **no AI claim is recalled as fact until a human approves
it.** State is two independent axes:

**Trust** (who vouches) — the AI writes only `proposed`/`verified`; `canonical` is a projection of a
logged human approval, never the frontmatter alone:

| trust | means | who writes it |
|-------|-------|---------------|
| `proposed` | AI claim, unchecked | capture / compile |
| `verified` | checked against the repo | compile (automatic) |
| `canonical` | **a human approved it** | `bureau:review` only |

**Freshness** (does it still hold) — derived by the gate, orthogonal to trust. A page can be
`canonical` *and* `stale` at once:

| freshness | means |
|-----------|-------|
| `current` | every upstream claim it rests on is unchanged since last confirmed |
| `needs-review` | it sits on an upstream claim that changed |
| `stale` | a dependency is broken (target/span gone) |

(Plus `contested`/`resolved` for conflicts, and a `freeze` change-priority hint.) The tier + freshness
travel with every recalled claim, so an unverified or stale claim can never masquerade as fact.

## One self-contained plugin

| | role |
|---|---|
| **bureau** (this plugin) | the engine: capture · compile · review · lint, plus the recursion engine (scan · gate · fsck) and the versioned board |
| **press** (`press/`, bundled inside bureau) | builds the gazette + runs the structural checks + the recursion engine (deterministic, no LLM) |
| `canon/` (in your repo) | **your data:** cabinet drawers + the `logbook/` drawer + the decision log |
| `bureau/` (in your repo) | bureau's **control dir** (the crew) — reserved, never rendered |

the press is a self-contained Node bundle vendored into the plugin (`press/bin/gazette.mjs`, no
`node_modules`). bureau runs it directly — there is **no separate install**. The bundle is
regenerated from the renderer source by `scripts/build-gazette.mjs`.

## Workspace layout

```
canon/             ← the content dir (default; auto-detected). Top-level folders are nav sections.
  decisions/       ← a cabinet drawer (ADRs)
  architecture/    ← cabinet drawer (software profile)
  logbook/         ← append-only history — RENDERS as its own section
  _config.json     ← gazette meta (title, home, provenance lane, sidebar order)
  bureau.json      ← profiles, board dir, autoCompile
  _log.jsonl       ← the decision log — SOURCE OF TRUTH for the recursion engine (committed)
bureau/crew/       ← bureau's control dir (the crew) — reserved, never rendered
gazette/           ← the rendered gazette (derived, gitignored, outside the workspace)
.bureau-cache/     ← the engine's derived gate cache (derived, gitignored, regenerable by fsck)
```

The workspace holds only **source + committed decisions**; every derived artifact (the board, the
gate cache, historical builds) lives *outside* it. The sidebar section order is configurable — list
section ids in `_config.json`'s `groups[]`.

## Commands

**The gated pipeline** (`bureau:*` — capture → compile → review → read):

| Command | Does |
|---------|------|
| `bureau:init` | scaffold the workspace, write `BUREAU.md` + import it from `CLAUDE.md`, wire the press |
| `bureau:note` | take a live note into the running minute (run at decision points) |
| `bureau:file-session` | file the rich minute for the current session |
| `bureau:compile` | distil minutes into dossiers (with provenance) |
| `bureau:review` | the human gate — promote vetted claims to `canonical`, confirm dependencies, resolve conflicts |
| `bureau:lint` | semantic consistency sweep across the cabinets |
| `bureau:query` | answer from the canon — cited, tier- and freshness-aware, never stating an unverified/stale claim as fact |
| `bureau:status` | uncompiled sessions · pages by tier · **needs-review / stale (the gate)** |
| `bureau:impact` | pre-change blast radius — which pages rest on a claim before you change it |
| `bureau:inspect` | build + open the gazette |
| `bureau:serve` | the interactive chamber + the **live freshness board** |
| `bureau:snapshot` | render any past board · diff two versions · pin named snapshots |
| `bureau:cycle` | the full lifecycle in one command: capture → compile → scan → lint → review → inspect |
| `bureau:crew` | enable or author specialized agents (a "crew") that work the canon |

**The engine, underneath** (deterministic; run for you by the commands above, or directly): `gazette
scan · gate · fsck · report · telemetry · approve · confirm · resolve · ledger · build --at · diff ·
snapshot` — see the [CLI reference](docs/cli-reference.md).

Two hooks run automatically: `SessionEnd` writes a mechanical logbook **stub** (no session is ever
lost); `SessionStart`-after-compaction re-grounds the agent from the logbook.

## Documentation

- **[User Guide](docs/user-guide.md)** — quickstart, worked example, what to run when.
- **[The recursion engine](docs/recursion-engine.md)** — dependency-aware freshness, end to end.
- **[Live & versioned board](docs/live-and-versioned-board.md)** — `serve`, `build --at`, `diff`, `snapshot`.
- **[CLI reference](docs/cli-reference.md)** — every `gazette` verb + the artifact map.
- **[ADR-0001](docs/adr-0001-engine-data-model.md)** — the frozen engine data model.

## Requirements

- **Node.js ≥ 18** on `PATH` — the `SessionEnd` capture hook and the bundled press both run `node`.
  If Node is absent the hook no-ops (it never blocks session end); you can still capture with
  `bureau:file-session`.
- The versioned board (`build --at` / `diff` / `snapshot`) uses **git**; the rest does not.
- Nothing else — the press is bundled, so there is no separate renderer to install.

## Install

```bash
claude plugin install bureau@xiaolai --scope project
```

Part of the [xiaolai marketplace](https://github.com/xiaolai/claude-plugin-marketplace).

## License

MIT
