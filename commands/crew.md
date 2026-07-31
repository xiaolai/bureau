---
description: Manage bureau's crew — list, enable, or author specialized agents that work the canon.
argument-hint: "[list | enable <name> [--workspace <ws>] | new <name> [--role \"…\"] [--workspace <ws>] | disable <name> [--purge] | update <name>|--all [--check] | sync | check]"
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
repo root). The first token of `$ARGUMENTS` selects the subcommand — one of `list`, `enable`, `new`,
`disable`, `update`, `sync`, `check` (default `list` when empty). If it is none of these, report the
unrecognized subcommand and list the valid ones — never guess at a near match. The subcommands:

## `list` (default)

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" list` and relay its roster verbatim — the installed
members with their enabled/disabled state and source, the shipped members available to enable, and the
author hint (exact shape in **Output** below).

## `enable <name>`

For a member bureau ships (currently: **auditor**). Run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" enable <name>`. This copies the shipped template into
`bureau/crew/<name>/` (so you own and can edit it), substitutes the workspace name, materializes the
agent, and adds the brief's `@import` to `BUREAU.md`. Relay the engine's `✓ crew: enabled …` line (see
**Output**); the `<name>` agent is now invocable. **Precondition:** if `BUREAU.md` does not exist at the repo root, stop and tell
the user to run `bureau:init` first — do not partially enable. If `<name>` is not a shipped member,
stop and list the members `bureau:crew list` reports as available. The workspace substituted into the
member's grounding prompt is auto-detected from the single marker-carrying dir; if the repo has more
than one workspace the engine stops and asks — pass `--workspace <ws>` to pick one.

## `new <name> [--role "…"]`

Author a **local** desk. Two steps:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" new <name> --role "<role>"` to scaffold
   `bureau/crew/<name>/` from the template and materialize the skeleton. (As with `enable`, the
   workspace is auto-detected; pass `--workspace <ws>` if the repo has more than one.)
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
your editable source under `bureau/crew/<name>/` unless `--purge`. Relay the engine's `✓ crew: disabled …`
line (see **Output**).

## `update <name> | --all [--check]`

Pull later improvements to a **shipped** member's template into your editable copy, without clobbering
your local edits. When you `enable` a shipped member, the engine records `upstream` tracking in its
`crew.json` (the frozen substitution bindings + a per-file sha of the accepted base). `update`
re-substitutes the *current* shipped template and does a conservative **file-level 3-way merge**
against that base:

- a file only **upstream** changed → advanced to the new version,
- a file only **you** edited → kept as-is,
- a file **both** sides changed → a **conflict**: nothing is written, resolve it in the source
  (`bureau/crew/<name>/`) and re-run.

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" update <name>` (or `--all` for every shipped
member). Add `--check` for a read-only plan (reports `up-to-date` / `update available` / `conflict` /
`untracked` / `local`, exits non-zero when an update or conflict is pending — CI-friendly). A `local`
member (authored with `new`) has no upstream and is skipped. A member enabled before update tracking
existed reports as `untracked`; to start tracking it must be re-installed fresh (`disable --purge`,
then `enable`), which replaces the local copy with the shipped template — so back up any local edits
first. It is never auto-baselined. After applying, it re-runs `sync`, so the same transactional
validation applies.

## `sync`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" sync` to (re)materialize every enabled member and
clean up artifacts of disabled ones. Use after editing a member's source, or after pulling a repo
whose `.claude/` materializations are stale/absent.

## `check`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" check`. It validates that each enabled member's
materialized agent/skills are in sync with the source (by hash), the brief is `@import`-ed, frontmatter
is valid, and there are no orphaned generated files. Exits non-zero on any problem (CI-friendly).
Relay the engine's `✓`/`✗ crew check` output verbatim (see **Output**); the fix is almost always
`bureau:crew sync`.

## Output

Each subcommand's real output is the engine's stdout — **relay it verbatim**, never paraphrase, and
report the exit status (a leading `✓` is success; a leading `✗` is a failure with a non-zero exit). The
exact shapes:

- **`list`** — a `Crew` heading, then one line per installed member `<●|○> <name> <shipped|local> <role>`
  (`●` enabled, `○` disabled), then `available (shipped): <names>   → bureau:crew enable <name>` (when
  any remain) and `author your own   → bureau:crew new <name>`.
- **`enable`** — `✓ crew: enabled "<name>" — agent .claude/agents/<name>.md, brief @bureau/crew/<name>/brief.md. active: <names>`.
- **`new`** — `✓ crew: scaffolded local member "<name>" …`, then the two-line "Edit … then run `bureau:crew sync`" reminder.
- **`disable`** — `✓ crew: disabled "<name>" (source kept at bureau/crew/<name>/).` — or `… and purged its source.` with `--purge`.
- **`update`** — a `crew update:` header (`crew update — plan (no changes written):` under `--check`),
  then one line per member `<name>: <status>[ — <detail>]` (status is one of `up-to-date`, `update`,
  `conflict`, `blocked`, `untracked`, `local`, `gone`), then `✓ crew update: <N> member(s) updated +
  re-materialized.` (or `everything already up-to-date.`). A conflict or blocker exits non-zero and
  writes nothing.
- **`sync`** — `✓ crew sync: <N> member(s) materialized (<names>)`.
- **`check`** — clean: `✓ crew check: <N> member(s) in sync (<names>)`. Otherwise `✗ crew check: <N>
  issue(s)` followed by one `  - <issue>` bullet per problem, and a non-zero exit.

## Notes

- A member's agent is a **native project subagent** — it works even with bureau uninstalled; bureau
  only manages the source + wiring. Local members named the same as a shipped one shadow it.
- The whole `bureau/crew/` tree is plain files — commit it and your teammates get the crew on pull
  (`bureau:crew sync` materializes on their side, or `bureau:init` does it for them).
