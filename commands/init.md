---
description: Scaffold a bureau workspace (cabinets + logbook) in the current repo and wire the press.
argument-hint: "[--workspace <name>] [--profile software|story|both] [--reinit | --fresh]"
---

# bureau:init

Scaffold a **bureau workspace** in the current repository: the canonical cabinet drawers,
the append-only logbook drawer, and the config the press needs to render them.

## Arguments

`$ARGUMENTS` may contain:
- `--workspace <name>` — workspace/content dir name (default `canon`). `--workspace bureau` selects
  the **contained layout** — workspace content, the crew source (`bureau/crew/`), and the rendered
  board (`bureau/gazette/`) all live inside one `bureau/` dir. Other reserved names (`crew`,
  `board`, `gazette`, …) are rejected (see step 1).
- `--profile software|story|both` — which starter drawers + lint rules to enable (default `both`).
- `--reinit` — re-run against an **existing** workspace: keep all cabinet + logbook content, just
  refresh the wiring (`BUREAU.md`, the `CLAUDE.md` import, profile drawers, board gitignore) and
  re-validate. Safe and idempotent — the supported way to "re-init" a repo.
- `--fresh` — start the workspace over: **back up** the existing one to `<workspace>.bak-<timestamp>`
  (never deleted), then scaffold a clean workspace from the template.
- `--external <name>` — create the workspace **outside** this repo (ADR-0003), for a **public** code
  repo whose knowledge must stay private. Instead of an in-repo child dir, it scaffolds
  `~/bureaus/<name>/canon` (its own git repo), records a **user-local** mapping, and commits only a
  path-free `.bureau-id` to this repo. See "External workspace mode" below — do not combine with the
  in-repo modes.

`--reinit` and `--fresh` are mutually exclusive — if both are passed, stop and report. Both only
matter when the workspace already exists; on a first init they are no-ops.

## Steps

1. **Resolve + validate names and mode.** `workspace` = `--workspace` or `canon` (the default).
   **Reject** any workspace name that is either (a) not a single safe path segment — it must match
   `^[A-Za-z0-9._-]+$` and not be `.`/`..` (no absolute paths, no `/`, no `..`; the workspace is
   always a direct child of the repo root) — or (b) a **reserved name**: `crew`, `board`,
   `gazette`, `dist`, `node_modules`, `.git`, `.claude`. `gazette` is the default board name (the
   rendered output you build and open), and `crew`/`board` would collide with the crew dir and the
   legacy board name. `bureau` is NOT rejected: `--workspace bureau` is the sanctioned **contained
   layout** — the workspace and bureau's control plane become the same directory, so the crew nests
   at `bureau/crew/` (its usual home, now inside the workspace) and the board renders at
   `bureau/gazette/` (`<workspace>/<board>` — the ONE case where the board lives inside the
   workspace). The press treats both as non-content: it always skips a top-level `crew/`, and — in
   the contained layout only (a workspace named `bureau`) — the configured board dir too, with
   `guardOutDir` permitting exactly that board child. In a default-layout workspace the board name
   is NOT special, so nothing inside the workspace is exempt. `board` = `bureau.json.board` (default
   `gazette`), validated the same way and kept distinct from the workspace name and from `crew` —
   and, because in the contained layout it lives inside the workspace, also distinct from the drawer
   names `logbook` and `lint`. (The press enforces this at runtime too: a hand-edited or corrupted
   `board` that is unsafe or names a reserved control/source dir — `crew`, `logbook`, `lint`,
   `bureau.json`, a `_`/`.`-prefixed name — fails safe to `gazette`, so the render can never be
   pointed at source to clobber it.)
   `profiles` = `--profile` (default `both` → `["software","story"]`). `mode` = `fresh` if
   `--fresh`, `reinit` if `--reinit`, else `default` — and if BOTH flags are present, stop and
   report (mutually exclusive).

2. **Handle an existing workspace (symlink-aware, mode-aware).** Resolve `<workspace>` and `lstat`
   it. If it exists as a **symlink**, stop and report (never write through a link). Confirm the
   realpath of the target stays inside the repo root before writing anything. If `<workspace>`
   does **not** exist, proceed with a normal fresh scaffold (steps 3–8) — the mode flags are
   no-ops. **Contained-layout exception:** with `--workspace bureau`, a pre-existing `bureau/` that
   carries **no `bureau.json`** and contains nothing but the crew source (`bureau/crew/`) is not an
   existing workspace — it is bureau's control dir predating this init. Treat it as absent and
   proceed with the fresh scaffold (step 3's no-overwrite copy coexists with `crew/`). Otherwise,
   if it exists as a non-empty directory, branch on `mode`:
   - **`default`** → stop. Do not overwrite an existing canon. Report the two supported re-runs —
     `--reinit` (refresh the wiring, keep all cabinet + logbook content) and `--fresh` (start over;
     the old workspace is backed up first) — plus `bureau:inspect` to just rebuild the gazette.
   - **`reinit`** → keep the workspace and ALL its content untouched. **Skip steps 3–4** (no
     template copy, no config rewrite over existing files). Proceed to step 5 (ensure profile
     drawers exist — never overwrite) and steps 6–8 (refresh `BUREAU.md` from the current template,
     re-assert the `CLAUDE.md` import, re-ignore the gazette, re-validate). This is the safe,
     idempotent re-init.
   - **`fresh`** → **back up, never delete**: move `<workspace>/` to `<workspace>.bak-<UTC
     timestamp>` (a sibling at the repo root, recoverable), then proceed with a normal fresh
     scaffold (steps 3–8). Report where the backup went, and that the user can delete it once happy
     or restore from it (or from git).

3. **Copy the template (no overwrite).** Copy `${CLAUDE_PLUGIN_ROOT}/templates/workspace/`
   into `<workspace>/` without overwriting any existing file, then replace every `{{DATE}}`
   token with today's date (YYYY-MM-DD). This lays down:
   - `_config.json` (gazette meta + the `provenance` block that arms the `unsourced` health lane)
   - `bureau.json` (profiles, workspace, board dir, autoCompile)
   - `00-overview.md`, `decisions/0001-adopt-bureau.md` (a starter cabinet drawer)
   - `logbook/00-logbook.md` (the history drawer landing page) and `logbook/0001-founding.md`
     (the founding minute — the seed ADR cites it, so a fresh workspace demonstrates the whole
     provenance loop: claim → minute, with the backlink rendered)
   - `.gitignore` (workspace-level note; the board is ignored via the repo-root `.gitignore` — step 7)

4. **Write resolved config.** Update `<workspace>/bureau.json` so BOTH `profiles` AND
   `workspace` (and `board`) reflect the resolved values — a custom `--workspace` must not
   leave the template's default `"canon"` behind.

5. **Add profile drawers, and arm the provenance check.** Two parts:

   a. For each active profile, create the suggested empty drawers when missing (never overwrite):
   - **software** → `architecture/`, `modules/` (plus the shared `decisions/`)
   - **story** → `characters/`, `timeline/`, `canon/`

   b. Ensure `<workspace>/_config.json` carries the `meta.provenance` block — **in every mode,
      including `--reinit`**, since an existing workspace predates this check and is exactly the
      one most likely to have unsourced pages. Merge it in without disturbing other `meta` keys:

      ```json
      "provenance": {
        "requireFor": ["proposed", "verified", "canonical", "contested", "stale"],
        "sourceGroup": "logbook",
        "exclude": ["Logbook"]
      }
      ```

      This arms the `unsourced` health lane: any page carrying a trust tier that never links back
      into the logbook is a claim with no provenance, and `gazette health` fails on it. On an
      existing workspace this can surface findings on the first run — that is the point; they were
      always there, just invisible. Report them and point at the fix (a body `**Sources.**` line),
      never a frontmatter `sources:` key.

6. **Write the bureau instructions and wire `CLAUDE.md` to import them.** Two parts:

   a. Copy `${CLAUDE_PLUGIN_ROOT}/templates/bureau-instructions.md` to the **repo root** as
      `./BUREAU.md`, replacing `{{WORKSPACE}}` with the resolved workspace name. Do not overwrite an
      existing `BUREAU.md` without asking — **except** under `--reinit`/`--fresh`, where refreshing
      it from the current template (re-substituting `{{WORKSPACE}}`) is the whole point: overwrite
      it. `BUREAU.md` lives at the repo root (sibling of `CLAUDE.md`) — never inside `.claude/rules/`
      (that path auto-loads, so importing it too would load it twice) and never inside the workspace
      (the press would render it as a dossier).

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

7. **Gitignore the board at the repo root.** Add the board's repo-root-relative path to the
   **repo root** `.gitignore` (create it if absent): `/<board>/` in the default layout (the board
   renders as a repo sibling of the workspace), or `/<workspace>/<board>/` (i.e. `/bureau/gazette/`)
   in the contained layout, where the board renders inside the workspace. Do NOT rely on the
   workspace-level `.gitignore` for this — in the default layout it can't reach a sibling dir.

8. **Materialize the crew (if any).** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" sync`. On a
   fresh init this is a no-op (no crew enabled yet); its job is to regenerate the `.claude/agents/`
   and `.claude/skills/` for any desks already committed under `bureau/crew/` — e.g. after a
   teammate clones a repo whose materializations weren't committed. Manage the crew with
   `bureau:crew`.

9. **Validate the scaffold.** Confirm `_config.json` and `bureau.json` parse as JSON, no
   `{{DATE}}`/`{{WORKSPACE}}` tokens remain (including in `./BUREAU.md`), `./CLAUDE.md` contains an
   `@BUREAU.md` import line, a `bureau:inspect` build succeeds, and `crew.mjs check` passes (or is a
   clean no-op). Report any failure with the offending file — do not claim success on a workspace
   that won't build.

10. **Report.** State the mode and what it did: `default`/`fresh` → the created tree (note
    `./BUREAU.md` + the `CLAUDE.md` import); `fresh` → also where the old workspace was backed up;
    `reinit` → what was refreshed and that all cabinet/logbook content was preserved. Then the next
    steps: `bureau:inspect` to build/open the gazette, `bureau:file-session` (or `bureau:note`) during
    a session, `bureau:query` to ask the canon, and `bureau:crew` to add specialized agents.

## External workspace mode (`--external <name>`) — ADR-0003

For a **public** code repo whose knowledge must stay private, scaffold the workspace OUTSIDE this
repo. The code repo then carries only a path-free `.bureau-id`; the canon lives in its own private,
backed-up git repo, resolved per-machine through a user-local mapping. Do **not** run the in-repo
steps above — instead:

1. **Resolve names.** `name` = `--external <name>` (validate `^[A-Za-z0-9._-]+$`, not `.`/`..`). The
   workspace root is `~/bureaus/<name>/` and the workspace itself is its **child**
   `~/bureaus/<name>/canon` — a child so the versioned board can address it (a workspace that IS the
   git top-level is refused). Mint an opaque, path-free `id` (e.g. `<name>-<8 hex>`), matching
   `^[A-Za-z0-9._-]+$`.

2. **Scaffold the external workspace.** Create `~/bureaus/<name>/`, `git init` it, copy
   `${CLAUDE_PLUGIN_ROOT}/templates/workspace/` into `~/bureaus/<name>/canon/` (same `{{DATE}}` /
   `{{WORKSPACE}}` substitution as the in-repo step 3; set `bureau.json.workspace` to `canon`), then
   commit it in that repo.

3. **Record the mapping (user-local).** Pair the id to the workspace with the safe writer — NEVER
   hand-edit `~/.config/bureau/workspaces.json`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.mjs" "<id>" "~/bureaus/<name>/canon"
   ```

4. **Mark the code repo.** Write `./.bureau-id` containing ONLY `<id>` (no path), and commit it. Add
   NOTHING else to this repo — no workspace dir, no board.

5. **Wire + validate.** Refresh `./BUREAU.md` and the `CLAUDE.md` `@BUREAU.md` import as in the
   in-repo steps 6–7. Validate with
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" fsck --dir ~/bureaus/<name>/canon` (from this
   repo, `gazette` also resolves it automatically via the `.bureau-id`).

6. **Back it up.** `~/bureaus/<name>` is now the sole copy — set up a real backup (a **private**
   remote and/or offsite/encrypted). A single local repo is NOT a backup. See
   `docs/adr-0003-external-workspace.md` (Decision E) and the backup note in
   `docs/live-and-versioned-board.md`.

7. **Report.** State the external workspace path, the committed `.bureau-id`, that the mapping was
   recorded, and the backup reminder. On another machine, restore `~/bureaus/<name>`, then run
   `bureau:pair`.

## Notes

- The workspace is the user's DATA; this plugin is the engine. Never put workspace content
  inside the plugin.
- The workspace is DATA — **back it up.** A single local repo (or a local mirror) is not a backup;
  real durability needs a tested, offsite/encrypted backup, especially for a private external
  workspace. See `docs/adr-0003-external-workspace.md` (Decision E).
- In the **default layout** the board MUST stay outside the workspace — the press's `guardOutDir`
  refuses an `--out` that overlaps the content dir, which protects the SSOT from being clobbered by
  its render. The **contained layout** is the one sanctioned exception: `guardOutDir` permits
  exactly `<workspace>/<board>` (the child named by the workspace's own `bureau.json`), and the
  press excludes that child — plus `crew/` — from content discovery and the incremental input hash,
  so the render can neither clobber source nor feed back into the next build.
