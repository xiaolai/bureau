---
title: session testing · 2026-06-11
updated: 2026-06-11
status: logbook
session: testing
transcript: ""
---

## [2026-06-11] session testing — the E2E pyramid

**Intent.** Plugins are mostly prompts executed by an LLM; how do you E2E-test that?

**Decisions.**
- The reframe: **assert on what the plugin DOES (files, state, board, trace), not what the
  model SAYS.** Side-effects are deterministic; prose isn't. — implies cabinet page **Testing strategy**
- A layered pyramid: L0 static · L1 substrate units (hook scripts + gazette) · L1 browser
  render (real Chromium) · L3 judge self-test (deterministic) · L3 live behavioral (`claude -p`
  + judges). — implies cabinet page **Testing strategy**
- Prove the judges themselves before trusting them (judges.test.mjs, no LLM). Judge semantic
  bits with a separate model. — implies cabinet page **Testing strategy**
- Equip Playwright as a real gazette devDep; the browser layer runs in CI on every push. —
  implies cabinet page **Testing strategy**

**Changes.**
- `test/` (static, unit, e2e harness + judges), `gazette/test/browser.test.mjs`,
  `.github/workflows/test.yml`. 180 deterministic checks green locally + CI.

**Open threads.**
- The live layer is environment-coupled (needs claude CLI + auth + the plugin installable).

**Source.** this session.
