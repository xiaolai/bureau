# Testing bureau

A plugin is mostly **prompts executed by an LLM** over a **deterministic substrate** (hook
scripts + the bundled gazette renderer). So "E2E" splits cleanly, on one reframe:

> **Assert on what the plugin _does_ — files, state, the board, the trace — not on what the
> model _says_.** The prose varies every run; the side-effects don't.

That turns "untestable probabilistic plugin" into a normal pyramid.

## The pyramid

| Layer | What it proves | Deterministic? | Run |
|---|---|---|---|
| **L0 static** | manifests parse, frontmatter present, refs resolve, the bundle ships | yes, free | `node test/static/check.mjs` |
| **L1 substrate** | hook scripts (`capture-stub`, `scribe-checkpoint`) + the gazette renderer | yes | `node --test test/unit/scripts.test.mjs` · `cd gazette && node --test` |
| **L3 judge self-test** | the L3 *assertions themselves* are correct (good workspace passes, bad fails) | yes, no LLM | `node --test test/e2e/judges.test.mjs` |
| **L3 live behavioral** | the trust model holds when a real LLM drives the flow | no — `claude -p` | `node test/run.mjs --e2e` |

Run the whole deterministic set with **`node test/run.mjs`** (174 checks, no API needed). Add
**`--e2e`** for the live layer (needs the `claude` CLI authenticated; costs tokens).

## How the live layer works (`test/e2e/`)

Per scenario: a throwaway git repo with bureau installed project-scoped → each step driven by a
real `claude -p` call → **judges** applied to the result:

- **Rule judges** (`judges/rule.mjs`) — deterministic checks of workspace *state*: did a logbook
  entry appear? did `compile` create a page at `proposed`/`verified` (and **never** `canonical`)?
  did the board build with 0 dangling/orphans? Asserted on **content + tier**, not exact titles
  (the LLM picks titles).
- **LLM judge** (`judges/llm.mjs`) — the irreducibly-semantic checks, graded by a *separate*
  `claude -p` call against a precise rubric (judge-with-a-different-context). e.g. *"did `query`
  refuse to state a `proposed` claim as fact?"*, *"did `review` decline to auto-promote to
  `canonical` without approval?"*

The judges are **proven correct first** (`judges.test.mjs`, no LLM), so a green/red verdict from
the live run means what it says.

## Principles (why this is tractable)

1. **Push logic into deterministic scripts; keep NL artifacts thin.** The more real work lives in
   `scripts/` and `gazette/`, the more E2E is just unit testing. bureau is built this way.
2. **Trace + side-effects over N-run thresholds.** Judge what actually happened; it's stabler and
   more diagnosable than statistical pass-rates. Reserve probabilistic checks for genuinely fuzzy
   behavior.
3. **Judge with a different model/context.** Don't let the author grade itself.
4. **Layer by cost.** L0–L1 + the judge self-test every commit (CI `deterministic` job); the live
   layer on demand (CI `behavioral` job, `workflow_dispatch` + `ANTHROPIC_API_KEY`).

## Honest limits

- The live layer is **environment-coupled**: it needs the `claude` CLI, auth, and the plugin
  installable. Some wiring (the `SessionStart(compact)` matcher, `additionalContext` injection)
  only an install-smoke against the *target Claude Code version* confirms — the "verify in target
  version" caveat in `scripts/scribe-checkpoint.mjs`.
- LLM judges are themselves probabilistic — crisp rubric, separate model, treat as a smoke alarm.
