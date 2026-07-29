---
description: Build the gazette (the offline gazette) with the bundled press, and open it for inspection.
argument-hint: "[--workspace <name>]"
---

# bureau:inspect

Render the workspace (cabinets + logbook) into a navigable offline **gazette** — the board you
read — with the bundled **press** (bureau's renderer), and open it. The press ships inside this
plugin (`${CLAUDE_PLUGIN_ROOT}/press/`), so there is nothing else to install.

## Steps

1. **Locate the workspace.** Use `--workspace <name>` if given; else look for a directory
   with a `bureau.json` (the single `*/bureau.json` at the repo root). Validate the name as a safe
   path segment (`^[A-Za-z0-9._-]+$`, not `.`/`..`). If none is found, tell the user to run
   `bureau:init` first.

2. **Read + validate config.** From `<workspace>/bureau.json` read `board` (default `gazette`)
   and validate it as a safe single path segment — reject `..`/absolute paths so output can't
   escape the repo. Then resolve the **board path**: `<workspace>/<board>` when the workspace is
   named `bureau` (the **contained layout** — the one case where the board lives inside the
   workspace; the press skips that child as content), else `<board>` at the repo root. The press's
   `guardOutDir` enforces the same rule — any other overlap with the workspace is refused.

3. **Build with the bundled press** — passing each argument separately (no shell string
   interpolation):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" build --dir <workspace> --out <board-path>
   ```
   The press is a self-contained Node bundle (no `node_modules`, Node ≥18). Report the dossier
   count from the build output.

4. **Findings.** The build prints COUNTS only. For the detailed structural findings (which
   dangling link, which orphan, which contradiction), run
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" health --dir <workspace>` and surface
   those. (Semantic findings are a separate concern — `bureau:lint`.)

5. **Open.** Open `<board-path>/index.html` (the gazette), or print the path if no opener is
   available.

## Notes

- This command only RENDERS. It never edits cabinets or logbook.
- **`bureau:inspect` builds a one-shot snapshot.** For a **live** board that hot-reloads and paints
  dependency freshness (needs-review/stale badges) as you edit, use **`bureau:serve`**. To render a
  **past** board, diff two versions, or pin a snapshot, use **`bureau:snapshot`**.
- The rendered board also carries the recursion engine's live **Drift** section on its Health page
  (dependency-aware freshness) alongside the structural checks below.
- Health findings here are STRUCTURAL (the press, deterministic). Semantic findings come from
  `bureau:lint`.
- The press is vendored into this plugin by `scripts/build-gazette.mjs` (regenerated from the
  renderer source); it is not a separate install.
