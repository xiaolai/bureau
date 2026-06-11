---
title: session gazette · 2026-06-11
updated: 2026-06-11
status: logbook
session: gazette
transcript: ""
---

## [2026-06-11] session gazette — the renderer, absorbed and renamed

**Intent.** Decide how bureau renders the board: depend on the separate `whiteboard` plugin,
or own it. Then make bureau completely independent.

**Decisions.**
- Make bureau **one self-contained plugin**: vendor the renderer in, no separate install. —
  implies cabinet page **gazette (the bundled dashboard)**
- The renderer's `node_modules` is gitignored, so a cloned plugin has no build deps → ship a
  **single esbuild bundle** (`gazette/bin/gazette.mjs`) with markdown-it / node-html-parser /
  sanitize-html inlined (createRequire banner so postcss's dynamic require resolves). Runs on
  Node ≥18 with no node_modules. — implies cabinet page **gazette (the bundled dashboard)**
- Rename the renderer **whiteboard → gazette**; bring its source + 160 tests in-tree; rebuild
  the bundle from rebranded source. — implies cabinet page **gazette (the bundled dashboard)**
- **Retire** the standalone whiteboard repo (local-only, content fully absorbed). bureau now
  has no external renderer dependency. — implies cabinet page **gazette (the bundled dashboard)**

**Changes.**
- `gazette/` (src + bin/gazette.mjs bundle + template + themes + 160 tests),
  `scripts/build-gazette.mjs`, `bureau:inspect` calls the bundle directly.

**Open threads.**
- The bundle's internal strings are clean; future renderer edits rebuild via build-gazette.

**Source.** this session.
