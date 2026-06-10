---
description: Scaffold a bureau workspace (cabinets + logbook) in the current repo and wire whiteboard.
argument-hint: "[--workspace <name>] [--profile software|story|both]"
---

# bureau:init

Scaffold a **bureau workspace** in the current repository: the canonical cabinet drawers,
the append-only logbook drawer, and the config whiteboard needs to render them.

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
   - `_config.json` (whiteboard meta)
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

6. **Gitignore the board at the repo root.** The board renders OUTSIDE the workspace (a repo
   sibling), so add `/<board>/` to the **repo root** `.gitignore` (create it if absent). Do
   NOT rely on the workspace-level `.gitignore` for this — it can't reach a sibling dir.

7. **Validate the scaffold.** Confirm `_config.json` and `bureau.json` parse as JSON, no
   `{{DATE}}` tokens remain, and a `bureau:inspect` build succeeds. Report any failure with the
   offending file — do not claim success on a workspace that won't build.

8. **Report.** Print the created tree and the next steps: `bureau:inspect` to build/open the
   board, `bureau:file-session` at the end of a working session.

## Notes

- The workspace is the user's DATA; this plugin is the engine. Never put workspace content
  inside the plugin.
- `board/` MUST stay outside the workspace — whiteboard's `guardOutDir` refuses an `--out`
  that overlaps the content dir, which protects the SSOT from being clobbered by its render.
