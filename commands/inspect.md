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
   and validate it as a safe single path segment under the repo root — reject `..`/absolute
   paths so output can't escape the repo. The gazette MUST be outside the workspace (the press's
   `guardOutDir` enforces this too).

3. **Build with the bundled press** — passing each argument separately (no shell string
   interpolation):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" build --dir <workspace> --out <board>
   ```
   The press is a self-contained Node bundle (no `node_modules`, Node ≥18). Report the dossier
   count from the build output.

4. **Findings.** The build prints COUNTS only. For the detailed structural findings (which
   dangling link, which orphan, which contradiction), run
   `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" health --dir <workspace>` and surface
   those. (Semantic findings are a separate concern — `bureau:lint`.)

5. **Open.** Open `<board>/index.html` (the gazette), or print the path if no opener is available.

## Notes

- This command only RENDERS. It never edits cabinets or logbook.
- Health findings here are STRUCTURAL (the press, deterministic). Semantic findings come from
  `bureau:lint`.
- The press is vendored into this plugin by `scripts/build-gazette.mjs` (regenerated from the
  renderer source); it is not a separate install.
