---
description: Scaffold a bureau workspace (cabinets + logbook) in the current repo and wire gazette.
argument-hint: "[--workspace <name>] [--profile software|story|both]"
---

# bureau:init

Scaffold a **bureau workspace** in the current repository: the canonical cabinet drawers,
the append-only logbook drawer, and the config gazette needs to render them.

## Arguments

`$ARGUMENTS` may contain:
- `--workspace <name>` — workspace/content dir name (default `bureau`).
- `--profile software|story|both` — which starter drawers + lint rules to enable (default `both`).

## Steps

1. **Resolve + validate names.** `workspace` = `--workspace` or `bureau`. **Reject** any
   workspace name that is not a single safe path segment: it must match `^[A-Za-z0-9._-]+$`
   and not be `.`/`..`. No absolute paths, no `/`, no `..` — the workspace is always a direct
   child of the repo root. `board` = `bureau.json.board` (default `board`), validated the same
   way. `profiles` = `--profile` (default `both` → `["software","story"]`).

2. **Refuse to clobber (symlink-aware).** Resolve `<workspace>` and `lstat` it. If it exists
   as a **symlink**, stop and report (never write through a link). If it exists as a non-empty
   directory, stop — do not overwrite an existing canon; suggest `bureau:inspect`. Confirm the
   realpath of the target stays inside the repo root before writing anything.

3. **Copy the template (no overwrite).** Copy `${CLAUDE_PLUGIN_ROOT}/templates/workspace/`
   into `<workspace>/` without overwriting any existing file, then replace every `{{DATE}}`
   token with today's date (YYYY-MM-DD). This lays down:
   - `_config.json` (gazette meta)
   - `bureau.json` (profiles, workspace, board dir, autoCompile)
   - `00-overview.md`, `decisions/0001-adopt-bureau.md` (a starter cabinet drawer)
   - `logbook/00-logbook.md` (the history drawer landing page)
   - `.gitignore` (workspace-level note; the board is ignored at the repo root — step 5)

4. **Write resolved config.** Update `<workspace>/bureau.json` so BOTH `profiles` AND
   `workspace` (and `board`) reflect the resolved values — a custom `--workspace` must not
   leave the template's default `"bureau"` behind.

5. **Add profile drawers.** For each active profile, create the suggested empty drawers when
   missing (never overwrite):
   - **software** → `architecture/`, `modules/` (plus the shared `decisions/`)
   - **story** → `characters/`, `timeline/`, `canon/`

6. **Write the bureau instructions and wire `CLAUDE.md` to import them.** Two parts:

   a. Copy `${CLAUDE_PLUGIN_ROOT}/templates/bureau-instructions.md` to the **repo root** as
      `./BUREAU.md`, replacing `{{WORKSPACE}}` with the resolved workspace name. Do not overwrite
      an existing `BUREAU.md` without asking. `BUREAU.md` lives at the repo root (sibling of
      `CLAUDE.md`) — never inside `.claude/rules/` (that path auto-loads, so importing it too would
      load it twice) and never inside the workspace (gazette would render it as a cabinet page).

   b. Make `CLAUDE.md` import it. Ensure the repo-root `./CLAUDE.md` exists (create it if absent),
      then append this idempotent block **once** — if a `<!-- bureau:start -->…<!-- bureau:end -->`
      block already exists, leave it untouched and do not add a second:

      ```
      <!-- bureau:start -->
      @BUREAU.md
      <!-- bureau:end -->
      ```

   The `@BUREAU.md` import (relative to `CLAUDE.md`, i.e. the repo root) is what loads the
   instructions into **every** session: `CLAUDE.md` auto-loads, and the import pulls `BUREAU.md` in
   with it. That is what makes every AI session in the repo honor the trust tiers when reading the
   cabinets as memory — the gate binds all work, not just bureau commands. (A future Codex
   `AGENTS.md` can import the same `BUREAU.md`, so the instructions stay single-sourced.)

7. **Gitignore the board at the repo root.** The board renders OUTSIDE the workspace (a repo
   sibling), so add `/<board>/` to the **repo root** `.gitignore` (create it if absent). Do
   NOT rely on the workspace-level `.gitignore` for this — it can't reach a sibling dir.

8. **Validate the scaffold.** Confirm `_config.json` and `bureau.json` parse as JSON, no
   `{{DATE}}`/`{{WORKSPACE}}` tokens remain (including in `./BUREAU.md`), `./CLAUDE.md` contains an
   `@BUREAU.md` import line, and a `bureau:inspect` build succeeds. Report any failure with the
   offending file — do not claim success on a workspace that won't build.

9. **Report.** Print the created tree (note `./BUREAU.md` + the `CLAUDE.md` import) and the next
   steps: `bureau:inspect` to build/open the board, `bureau:file-session` (or `bureau:note`)
   during a session, `bureau:query` to ask the canon.

## Notes

- The workspace is the user's DATA; this plugin is the engine. Never put workspace content
  inside the plugin.
- `board/` MUST stay outside the workspace — gazette's `guardOutDir` refuses an `--out`
  that overlaps the content dir, which protects the SSOT from being clobbered by its render.
