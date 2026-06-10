---
description: Write the rich logbook entry for the current session (intent, decisions, changes, open threads).
---

# bureau:file-session

File the **current** session into the logbook as a full entry. Run this at the end of a
working session, while you (the agent) still hold the full context — this is where the
high-fidelity record is written. The `SessionEnd` hook only writes a mechanical stub.

Follow the protocol in the **capture** skill (`skills/capture/SKILL.md`). In short:

1. Locate the workspace (discover a `bureau.json`; default `bureau`). If none, tell the user
   to run `bureau:init`.
2. Determine the logbook path `logbook/<YYYY>/<MM>/<safe-session-id>.md`, where the session id
   is sanitized to a safe slug per the capture skill (`[A-Za-z0-9_-]`, no path separators).
   If a mechanical stub already exists for this session, ENRICH it in place; otherwise create
   it.
3. When enriching a stub, **preserve the meaning, not the bytes** — re-derive a clean,
   sanitized frontmatter block (the stub's `session:`/`transcript:` values are untrusted; do
   not copy them verbatim if they contain quotes, newlines, or `[ ] |`).
4. Write the entry per the capture schema: intent, decisions, changed files, open threads, a
   transcript pointer. For each decision, name the cabinet page it implies; use a `[[link]]`
   only if that page **already exists** — otherwise write the target as plain text so the
   logbook doesn't ship dangling links (compile will create and link it).
5. Append-only in spirit: do not edit OTHER sessions' entries.
6. Do NOT touch cabinet pages — distilling into the canon is `bureau:compile` (planned).
7. Report the entry path.
