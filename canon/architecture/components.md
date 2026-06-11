---
title: Engine, renderer, workspace
updated: 2026-06-11
status: verified
---

# Engine, renderer, workspace

bureau is three things with clear boundaries:

- **The engine** — this plugin's commands + skills + hooks (capture · compile · review · lint ·
  query, plus the SessionEnd/SessionStart hooks). It *writes and reads* the knowledge base.
- **The renderer** — **gazette**, bundled inside the plugin, turns the workspace into a
  navigable offline board. See [[gazette (the bundled dashboard)]].
- **The workspace** — the user's data in their repo: **cabinet** drawers (the canon, overwritten
  to stay consistent) plus an append-only **logbook** (provenance). Two artifacts, opposite
  update semantics, kept separate.

**Verified.** `gazette/bin/gazette.mjs` (the renderer) and the `commands/` + `skills/` engine
both ship in the repo · checked 2026-06-11.

**Sources.** [[session architecture · 2026-06-11]], [[session gazette · 2026-06-11]]
