---
title: Testing strategy
updated: 2026-06-11
status: verified
---

# Testing strategy

Plugins are mostly prompts over a deterministic substrate, so E2E rests on one reframe:
**assert on what the plugin DOES — files, state, board, trace — not what the model SAYS.**

The pyramid:

- **L0 static** — manifests, frontmatter, cross-refs, the bundle ships.
- **L1 substrate** — hook scripts (driven exactly like Claude Code) + gazette's renderer suite.
- **L1 browser render** — the board loaded in real headless Chromium: offline/strict-CSP, 0
  console errors, nav + routing, mermaid→SVG, echarts→canvas, sortable tables.
- **L3 judge self-test** — proves the rule judges are correct (good passes, bad fails), no LLM.
- **L3 live behavioral** — `claude -p` drives real flows; rule judges on state + an LLM judge
  (separate model) on the semantic bits (e.g. did `query` refuse to state a `proposed` claim
  as fact).

**Verified.** `node test/run.mjs` runs 180 deterministic checks green (locally + CI on every
push, including the browser layer); the live layer runs on `workflow_dispatch` · checked
2026-06-11.

**Sources.** [[session testing · 2026-06-11]]
