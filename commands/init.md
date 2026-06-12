---
description: Scaffold a bureau workspace (cabinets + logbook) in the current repo and wire gazette.
argument-hint: "[--workspace <name>] [--profile software|story|both] [--reinit | --fresh]"
---

# bureau:init

Scaffold a **bureau workspace** in the current repository: the canonical cabinet drawers,
the append-only logbook drawer, and the config gazette needs to render them.

## Arguments

`$ARGUMENTS` may contain:
- `--workspace <name>` — workspace/content dir name (default `bureau`).
- `--profile software|story|both` — which starter drawers + lint rules to enable (default `both`).
- `--reinit` — re-run against an **existing** workspace: keep all cabinet + logbook content, just
  refresh the wiring (`BUREAU.md`, the `CLAUDE.md` import, profile drawers, board gitignore) and
  re-validate. Safe and idempotent — the supported way to "re-init" a repo.
- `--fresh` — start the workspace over: **back up** the existing one to `<workspace>.bak-<timestamp>`
  (never deleted), then scaffold a clean workspace from the template.

`--reinit` and `--fresh` are mutually exclusive — if both are passed, stop and report. Both only
matter when the workspace already exists; on a first init they are no-ops.

## Steps

1. **Resolve + validate names and mode.** `workspace` = `--workspace` or `bureau`. **Reject** any
   workspace name that is not a single safe path segment: it must match `^[A-Za-z0-9._-]+$`
   and not be `.`/`..`. No absolute paths, no `/`, no `..` — the workspace is always a direct
   child of the repo root. `board` = `bureau.json.board` (default `board`), validated the same
   way. `profiles` = `--profile` (default `both` → `["software","story"]`). `mode` = `fresh` if
   `--fresh`, `reinit` if `--reinit`, else `default` — and if BOTH flags are present, stop and
   report (mutually exclusive).

2. **Handle an existing workspace (symlink-aware, mode-aware).** Resolve `<workspace>` and `lstat`
   it. If it exists as a **symlink**, stop and report (never write through a link). Confirm the
   realpath of the target stays inside the repo root before writing anything. If `<workspace>`
   does **not** exist, proceed with a normal fresh scaffold (steps 3–8) — the mode flags are
   no-ops. If it exists as a non-empty directory, branch on `mode`:
   - **`default`** → stop. Do not overwrite an existing canon. Report the two supported re-runs —
     `--reinit` (refresh the wiring, keep all cabinet + logbook content) and `--fresh` (start over;
     the old workspace is backed up first) — plus `bureau:inspect` to just rebuild the board.
   - **`reinit`** → keep the workspace and ALL its content untouched. **Skip steps 3–4** (no
     template copy, no config rewrite over existing files). Proceed to step 5 (ensure profile
     drawers exist — never overwrite) and steps 6–8 (refresh `BUREAU.md` from the current template,
     re-assert the `CLAUDE.md` import, re-ignore the board, re-validate). This is the safe,
     idempotent re-init.
   - **`fresh`** → **back up, never delete**: move `<workspace>/` to `<workspace>.bak-<UTC
     timestamp>` (a sibling at the repo root, recoverable), then proceed with a normal fresh
     scaffold (steps 3–8). Report where the backup went, and that the user can delete it once happy
     or restore from it (or from git).

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
      `./BUREAU.md`, replacing `{{WORKSPACE}}` with the resolved workspace name. Do not overwrite an
      existing `BUREAU.md` without asking — **except** under `--reinit`/`--fresh`, where refreshing
      it from the current template (re-substituting `{{WORKSPACE}}`) is the whole point: overwrite
      it. `BUREAU.md` lives at the repo root (sibling of `CLAUDE.md`) — never inside `.claude/rules/`
      (that path auto-loads, so importing it too would load it twice) and never inside the workspace
      (gazette would render it as a cabinet page).

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

9. **Report.** State the mode and what it did: `default`/`fresh` → the created tree (note
   `./BUREAU.md` + the `CLAUDE.md` import); `fresh` → also where the old workspace was backed up;
   `reinit` → what was refreshed and that all cabinet/logbook content was preserved. Then the next
   steps: `bureau:inspect` to build/open the board, `bureau:file-session` (or `bureau:note`) during
   a session, `bureau:query` to ask the canon.

## Notes

- The workspace is the user's DATA; this plugin is the engine. Never put workspace content
  inside the plugin.
- `board/` MUST stay outside the workspace — gazette's `guardOutDir` refuses an `--out`
  that overlaps the content dir, which protects the SSOT from being clobbered by its render.
