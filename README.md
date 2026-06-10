# bureau

Turn AI sessions into a maintained, inspectable canon.

Every AI session is an unrecorded meeting; natural-language docs drift, go stale, and
contradict each other. **bureau** fixes that with four moves:

1. **Capture** every session to an append-only **logbook** (low authority, faithful record).
2. **Compile** logbook entries into consistency-checked **cabinet** pages — the SSOT, with
   provenance back to the session that introduced each claim.
3. **Review** — the human gate: AI-written claims are never trusted as fact until you approve
   them. Memory works like version control, not a notepad the AI scribbles in.
4. **Inspect** the whole thing as a navigable offline board, rendered by
   [whiteboard](https://github.com/xiaolai/whiteboard-for-claude).

This is the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
(LLM as compiler, not retriever) plus session provenance and a review gate — so the canon is
current, *traceable*, and *trusted*.

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

## Two plugins, one workspace

| | role |
|---|---|
| **bureau** (this plugin) | the engine: capture · compile · lint |
| **whiteboard** | render + structural integrity (deterministic) |
| `bureau/` (in your repo) | your data: cabinet drawers + the `logbook/` drawer |

bureau **depends on** whiteboard and changes nothing in it — it shells out to
`whiteboard build --dir bureau --out board`.

## Workspace layout

```
bureau/            ← whiteboard's content dir; top-level folders are nav sections
  decisions/       ← a cabinet drawer (ADRs)
  architecture/    ← cabinet drawer (software profile)
  characters/      ← cabinet drawer (story profile)
  logbook/         ← append-only history — RENDERS as its own section
  _config.json     ← whiteboard meta
  bureau.json      ← profiles, board dir, autoCompile
board/             ← rendered board (derived, gitignored, outside the workspace)
```

The canonical drawers (collectively, "cabinets") are the **SSOT**; `logbook/` is the
append-only history. Every cabinet claim links back to the logbook entry that introduced it.

## Commands

| Command | Does | Phase |
|---------|------|-------|
| `bureau:init` | scaffold the workspace, wire whiteboard | 0 |
| `bureau:inspect` | build + open the board | 0 |
| `bureau:file-session` | write the rich logbook entry for the current session | 1 |
| `bureau:compile` | distil logbook entries into cabinet pages (with provenance) | 2 |
| `bureau:review` | the human gate — promote vetted claims to `canonical`, reject the rest | 4 |
| `bureau:lint` | semantic consistency sweep across the cabinets | 3 |

A `SessionEnd` hook also writes a mechanical logbook **stub** automatically, so no session is
ever lost even if you forget to file it.

## Status

Phases 0–4 implemented (init, capture, inspect, compile, lint, review) — the full
capture → compile → review → inspect loop, with a trust-tier gate on memory. See
`dev-docs/plan.md`.

## Requirements

- **Node.js ≥ 18** on `PATH` — the `SessionEnd` capture hook runs `node`. If Node is absent
  the hook simply no-ops (it never blocks session end); you can still capture with
  `bureau:file-session`.
- The **whiteboard** plugin (rendering dependency).

## Install

```bash
claude plugin install bureau@xiaolai --scope project
claude plugin install whiteboard@xiaolai --scope project   # required dependency
```

Part of the [xiaolai marketplace](https://github.com/xiaolai/claude-plugin-marketplace).

## License

MIT
