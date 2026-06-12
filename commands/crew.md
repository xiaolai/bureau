---
description: Manage bureau's crew — list, enable, or author specialized agents that work the canon.
argument-hint: "[list | enable <name> | new <name> [--role \"…\"] | disable <name> [--purge] | sync | check]"
---

# bureau:crew

A **desk** is a specialized agent (plus its always-on brief, and optionally skills) that
works this repo's canon. Members are authored in `bureau/crew/<name>/` — the committed **source of
truth** — and *materialized* into Claude Code's native slots so it discovers them:

- the agent → `.claude/agents/<name>.md` (a project subagent, invocable as `<name>`),
- the brief → loaded every session via an `@import` in `BUREAU.md` (no copy),
- skills → `.claude/skills/<name>-*/`.

The materialized files under `.claude/` carry a `bureau:gen` marker and a source hash — **never edit
them by hand**; edit the source in `bureau/crew/<name>/` and run `bureau:crew sync`.

All work is done by the deterministic engine `${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs` (run from the
repo root). Parse `$ARGUMENTS` and act:

## `list` (default)

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" list` and show the result: which members are
installed/enabled, which shipped members are available to enable, and how to author your own.

## `enable <name>`

For a member bureau ships (currently: **auditor**). Run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" enable <name>`. This copies the shipped template into
`bureau/crew/<name>/` (so you own and can edit it), substitutes the workspace name, materializes the
agent, and adds the brief's `@import` to `BUREAU.md`. Report what landed and that the `<name>` agent
is now invocable. Requires `bureau:init` to have run (BUREAU.md must exist).

## `new <name> [--role "…"]`

Author a **local** desk. Two steps:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" new <name> --role "<role>"` to scaffold
   `bureau/crew/<name>/` from the template and materialize the skeleton.
2. **Then flesh it out** (this is the part worth your judgement): open
   `bureau/crew/<name>/agent.md` and `bureau/crew/<name>/brief.md` and replace the `REPLACE…`
   placeholders with a real persona — a precise `description:` (the trigger Claude uses to invoke
   it), the minimum `tools:` for the role (read-only judges keep `Read, Grep, Glob`), the right
   `model:`, the step-by-step job, and a one-paragraph brief. Keep the canon-grounding preamble.
   Then run `bureau:crew sync` to re-materialize. Confirm with `bureau:crew check`.

Validate the name is a safe slug (`^[a-z][a-z0-9-]*$`); the engine enforces this and contains all
writes to the repo.

## `disable <name> [--purge]`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" disable <name>` (add `--purge` to also delete the
source). This removes the materialized `.claude/agents/<name>.md` and the brief `@import`, but keeps
your editable source under `bureau/crew/<name>/` unless `--purge`. Report what was removed.

## `sync`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" sync` to (re)materialize every enabled member and
clean up artifacts of disabled ones. Use after editing a member's source, or after pulling a repo
whose `.claude/` materializations are stale/absent.

## `check`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" check`. It validates that each enabled member's
materialized agent/skills are in sync with the source (by hash), the brief is `@import`-ed, frontmatter
is valid, and there are no orphaned generated files. Exits non-zero on any problem (CI-friendly).
Surface the findings; the fix is almost always `bureau:crew sync`.

## Notes

- A member's agent is a **native project subagent** — it works even with bureau uninstalled; bureau
  only manages the source + wiring. Local members named the same as a shipped one shadow it.
- The whole `bureau/crew/` tree is plain files — commit it and your teammates get the crew on pull
  (`bureau:crew sync` materializes on their side, or `bureau:init` does it for them).
