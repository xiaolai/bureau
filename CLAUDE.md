# bureau — plugin development

Engine for turning AI sessions into a maintained, human-reviewed knowledge base. This repo
**dogfoods itself**: its own durable knowledge lives in `canon/`, governed by the trust gate that
the managed block below imports.

<!-- bureau:start -->
@BUREAU.md
<!-- bureau:end -->

## Prerequisites

- Node ≥ 18. The bundled press is self-contained — no `npm install` is needed to run the plugin.
  (`press/` carries dev dependencies for its own unit tests only.)

## Build & run

- Render the gazette: `node press/bin/gazette.mjs build --dir canon --out gazette`
- Check canon health: `node press/bin/gazette.mjs health --dir canon`
- Sync / verify the crew: `node scripts/crew.mjs sync` then `node scripts/crew.mjs check`
- Recursion engine (ADR-0001, `docs/adr-0001-engine-data-model.md`):
  `node press/bin/gazette.mjs scan --dir canon` (record span-revision events),
  `… gate --dir canon` (dirty index), `… fsck --dir canon` (byte-fixpoint, CI gate),
  `… report --dir canon` (auditable metrics). Rebuild the bundle after editing `press/src/engine/`:
  `node scripts/build-gazette.mjs`.

## Test

- Deterministic pyramid (no API, always green): `node test/run.mjs`
- Add the live behavioral layer (`claude -p` — needs auth + tokens): `node test/run.mjs --e2e`

## Plugin structure

| Path | Role |
|------|------|
| `commands/` | the `bureau:*` slash commands |
| `skills/` | model-triggered skills — one per pipeline step, plus the `guide` orientation skill |
| `crew/` | crew desk sources (`agent.md` + `brief.md`), materialized into `.claude/` on sync |
| `scripts/` | hook + crew engine — `crew.mjs` (materializer), capture/scribe session hooks |
| `press/` | the bundled renderer that builds the gazette; vendored, self-contained. `press/src/engine/` is the recursion engine (ADR-0001): decision log, span revisions, the deterministic gate, ledgers, fsck |
| `templates/` | workspace scaffold + the `BUREAU.md` instruction template `bureau:init` writes |
| `hooks/` | `hooks.json` wiring |
| `test/` | the deterministic test pyramid + the e2e harness |
