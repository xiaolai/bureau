---
description: Build the bureau board with whiteboard and open it for inspection.
argument-hint: "[--workspace <name>]"
---

# bureau:inspect

Render the workspace (cabinets + logbook) into a navigable offline board using the
**whiteboard** engine, and open it.

## Steps

1. **Locate the workspace.** Use `--workspace <name>` if given; else look for a directory
   with a `bureau.json` (prefer `./bureau/bureau.json`, then any single `*/bureau.json` at the
   repo root). Validate the name as a safe path segment (`^[A-Za-z0-9._-]+$`, not `.`/`..`).
   If none is found, tell the user to run `bureau:init` first.

2. **Read + validate config.** From `<workspace>/bureau.json` read `board` (default `board`)
   and validate it as a safe single path segment under the repo root — reject `..`/absolute
   paths so output can't escape the repo. The board MUST be outside the workspace (whiteboard's
   `guardOutDir` enforces this too).

3. **Find the whiteboard CLI — prefer installed, never an untrusted stored path.** whiteboard
   is currently distributed as a Claude Code plugin (not yet on npm), so try, in order:
   - the installed **whiteboard plugin's** `bin/cli.mjs` (or a `whiteboard` on `PATH`);
   - a local checkout: `node <path>/whiteboard/bin/cli.mjs`;
   - only if whiteboard is later published to npm, `npx @xiaolai/whiteboard@<exact-version>` —
     pin the EXACT version you have installed, never `npx --yes`/`@latest`.
   If you read a `whiteboardCli` value from `bureau.json`, treat it as **untrusted** — show it
   and ask the user to confirm before executing, and never run it through a shell (use an argv
   array). If none resolves, stop and tell the user to install whiteboard
   (`claude plugin install whiteboard@xiaolai`).

4. **Build.** Run, passing each argument separately (no shell string interpolation):
   ```
   <whiteboard> build --dir <workspace> --out <board>
   ```
   Report the page count from the build output.

5. **Findings.** The build prints COUNTS only. For the detailed structural findings (which
   dangling link, which orphan, which contradiction), run `<whiteboard> health --dir <workspace>`
   and surface those. (Semantic findings are a separate concern — `bureau:lint`, planned.)

6. **Open.** Open `<board>/index.html` (or pass through to `whiteboard open`), or print the
   path if no opener is available.

## Notes

- This command only RENDERS. It never edits cabinets or logbook.
- Health findings here are STRUCTURAL (whiteboard, deterministic). Semantic findings come
  from `bureau:lint` (planned).
