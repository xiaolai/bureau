# bureau

Turn AI sessions into a maintained, inspectable canon.

Every AI session is an unrecorded meeting; natural-language docs drift, go stale, and
contradict each other. **bureau** fixes that with three moves:

1. **Capture** every session to an append-only **logbook** (low authority, faithful record).
2. **Compile** logbook entries into consistency-checked **cabinet** pages — the SSOT, with
   provenance back to the session that introduced each claim.
3. **Inspect** the whole thing as a navigable offline board, rendered by
   [whiteboard](https://github.com/xiaolai/whiteboard-for-claude).

This is the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
(LLM as compiler, not retriever) plus session provenance — so the canon is not just current,
but *traceable*.

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
| `bureau:lint` | semantic consistency sweep across the cabinets | 3 (planned) |

A `SessionEnd` hook also writes a mechanical logbook **stub** automatically, so no session is
ever lost even if you forget to file it.

## Status

Phases 0–2 (init, capture, inspect, compile) implemented. Lint (3) — the semantic-consistency
sweep — is planned; see `dev-docs/plan.md`.

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
