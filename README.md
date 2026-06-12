# bureau

Turn AI sessions into a maintained, inspectable canon.

Every AI session is an unrecorded meeting; natural-language docs drift, go stale, and
contradict each other. **bureau** turns sessions into memory you can trust:

- **Write, gated.** **Capture** each session to an append-only **logbook** → **compile** into
  consistency-checked **cabinet** pages (the SSOT, with provenance) → **review**, the human gate
  that promotes a claim to `canonical`. AI-written claims are never fact until you approve them —
  memory works like version control, not a notepad the AI scribbles in.
- **Read, tier-aware.** **`query`** answers from the canon, citing each claim's trust tier and
  refusing to state an unverified one as fact. And **`BUREAU.md`** — the instructions `init` writes
  at your repo root and imports from `CLAUDE.md` — makes *every* AI session honor those tiers, so
  the gate governs all work, not just bureau commands.
- **Inspect.** A navigable offline **gazette** (the board), built by the bundled **press**
  inside this plugin (nothing else to install).

This is the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
(LLM as compiler, not retriever) plus session provenance, a review gate, and an always-on
`BUREAU.md` instruction — so the canon is current, *traceable*, and *trusted*.

**New here?** Start with the **[User Guide](docs/user-guide.md)** — a 60-second quickstart and a
worked example.

## Trust tiers — why memory here is safe

The cabinets double as repo memory, and **no AI claim is recalled as fact until a human
approves it.** Every page carries a `status:` the AI must honor on recall:

| `status:` | trust | who writes it |
|-----------|-------|---------------|
| `proposed` | AI claim, unchecked | capture / compile |
| `verified` | checked against the repo | compile (automatic) |
| `canonical` | **a human approved it** | `bureau:review` only |
| `stale` | a verified source changed | staleness re-check |
| `contested` | two claims disagree | lint |

AI writes only `proposed`/`verified`; the `proposed → review → canonical` gate is the
double-check. Facts-about-artifacts auto-verify; judgments route to the human.

## One self-contained plugin

| | role |
|---|---|
| **bureau** (this plugin) | the engine: capture · compile · review · lint |
| **press** (`press/`, bundled inside bureau) | builds the gazette + runs the structural checks (deterministic) |
| `bureau/` (in your repo) | your data: cabinet drawers + the `logbook/` drawer |

the press is a self-contained Node bundle vendored into the plugin (`press/bin/gazette.mjs`,
no `node_modules`). `bureau:inspect` runs it directly — there is **no separate install**. The
bundle is regenerated from the upstream renderer source by `scripts/build-gazette.mjs`.

## Workspace layout

```
canon/             ← the content dir (default name); top-level folders are nav sections
  decisions/       ← a cabinet drawer (ADRs)
  architecture/    ← cabinet drawer (software profile)
  characters/      ← cabinet drawer (story profile)
  logbook/         ← append-only history — RENDERS as its own section
  _config.json     ← gazette meta
  bureau.json      ← profiles, board dir, autoCompile
bureau/crew/       ← bureau's control dir (the crew) — reserved, never rendered
gazette/           ← the rendered gazette (derived, gitignored, outside the workspace)
```

The canonical drawers (collectively, "cabinets") are the **SSOT**; `logbook/` is the
append-only history. Every cabinet claim links back to the minute that introduced it.

## Commands

| Command | Does |
|---------|------|
| `bureau:init` | scaffold the workspace, write `BUREAU.md` + import it from `CLAUDE.md`, wire the press |
| `bureau:note` | take a live note into the running minute (run at decision points) |
| `bureau:file-session` | file the rich minute for the current session |
| `bureau:compile` | distil minutes into dossiers (with provenance) |
| `bureau:review` | the human gate — promote vetted claims to `canonical`, reject the rest |
| `bureau:lint` | semantic consistency sweep across the cabinets |
| `bureau:query` | answer a question from the canon — cited, tier-aware, never stating an unverified claim as fact |
| `bureau:status` | what's uncompiled / pending review / stale / contested |
| `bureau:inspect` | build + open the gazette (gazette) |
| `bureau:crew` | enable or author specialized agents (a "crew") that work the canon |

**Write** (gated): `note`/`file-session` → `compile` → `review`. **Read** (tier-aware):
`query`, plus **`BUREAU.md`** — written by `init` and imported from `CLAUDE.md` — which makes
*every* AI session honor the trust tiers, so the gate governs all work, not just bureau commands.

Two hooks run automatically: `SessionEnd` writes a mechanical logbook **stub** (no session is
ever lost); `SessionStart`-after-compaction re-grounds the agent from the logbook so decisions
survive a context compaction.

## Status

The full loop is implemented: capture (`note`/`file-session` + hooks) → compile → review →
lint, read via `query`/`status` under the `BUREAU.md` gate, built by the bundled press. See
`dev-docs/plan.md`.

## Requirements

- **Node.js ≥ 18** on `PATH` — the `SessionEnd` capture hook and the bundled press
  both run `node`. If Node is absent the hook simply no-ops (it never blocks session end); you
  can still capture with `bureau:file-session`.
- Nothing else — the press is bundled (`press/`), so there is no separate renderer to install.

## Install

```bash
claude plugin install bureau@xiaolai --scope project
```

Part of the [xiaolai marketplace](https://github.com/xiaolai/claude-plugin-marketplace).

## License

MIT
