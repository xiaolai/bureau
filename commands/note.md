---
description: Take a live note — summarize the current session's decisions/open threads into the running minute (or ephemerally if no workspace).
argument-hint: "[--workspace <name>]"
---

# bureau:note

Jot the current state of the session as a running logbook note — the live minute-taker, so the
record doesn't depend on end-of-session recall. Run it at decision points, not after every turn.

Follow the protocol in the **scribe** skill (`skills/scribe/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `canon`). If none, produce the summary for the
   user (ephemeral) and stop — do not error.
2. Summarize the span since the last note: decisions reached, what changed, open threads —
   faithful, including reversals.
3. Append a timestamped checkpoint to the session's running minute
   (`logbook/<YYYY>/<MM>/<safe-session-id>.md`, the same file `bureau:file-session` finalizes).
   Never rewrite earlier checkpoints or other sessions' entries.
4. Keep it `status: logbook` (low-authority, raw); never touch dossiers.
5. Report the note's path (or present the summary in ephemeral mode).
