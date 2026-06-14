---
description: Open the chamber — a localhost-only room serving the gazette read-only plus an intake form that files proposed claims as append-only logbook minutes (never canon). The interactive write surface that feeds the gate.
argument-hint: "[--port <n>] [--out <dir>] [--watch]"
---

# bureau:serve — open the chamber

Start the **chamber**: a single-user, localhost-only server that gives the human (and a convened
AI desk) an interactive room whose output feeds capture → compile → review instead of bypassing it.
It does three things — serve the gazette **read-only**, accept **intake** (a proposed claim) as an
append-only `status: logbook` minute, and host the **review/dispose** surface where a human promotes
vetted dossiers to `canonical`. Intake can never write a dossier or set a higher tier. Promotion is
gated by a **reviewer token** printed to the terminal at startup: **propose is open** (the human or a
convened AI desk), **dispose is the human's act** — the AI's agent context never sees that token.

## Steps

1. **Locate the workspace.** Find the bureau workspace (`bureau.json`; default `canon`). If none,
   tell the user to run `bureau:init` first and stop.
2. **Parse arguments.** `--port` (default `4317`), `--out` (the gazette dir; default `gazette`),
   `--watch` (rebuild the gazette when the workspace changes, so the served board stays fresh —
   refresh the browser to see it). Validate `--port` is an integer in `1024–65535`; otherwise report
   and stop.
3. **Start the server.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/serve.mjs" --port <port> --out <out> [--watch]` from the repo root. It
   binds `127.0.0.1` only — never a public interface. If the port is in use, report the error and
   suggest another `--port`.
4. **Report the URL + the reviewer token.** Print `http://127.0.0.1:<port>`, the **reviewer token**
   the server printed (the human pastes it in the chamber to approve/reject — do not echo it anywhere
   the AI seat would capture it), and what the room offers: the intake form and the pending-review
   list at `/`, the read-only gazette at `/gazette/` (if built — otherwise suggest `bureau:inspect`),
   and that Ctrl-C stops it.
5. **Explain the loop.** Remind the user that a proposed claim lands in the logbook as a minute; run
   `bureau:compile` to distil it into a `proposed` dossier, then `bureau:review` to promote vetted
   claims to `canonical`. The chamber proposes; the human disposes.

## Notes

- **Propose-only by construction.** The server's sole write power is appending logbook minutes; it
  validates every submission, caps body size, and realpath-contains every path to the workspace.
- **Read-only gazette.** Static files are served with path containment and no directory listing; the
  served gazette is exactly what `bureau:inspect` builds.
- The chamber is the interactive counterpart to the CLI intake (`bureau:note` / `bureau:file-session`)
  — same gate, friendlier surface.
