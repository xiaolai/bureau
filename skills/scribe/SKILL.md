---
name: scribe
description: The live note-taker — summarize the current session's decisions and open threads on demand or at checkpoints, and (in a bureau workspace) append them to the session's running logbook entry. Use when running bureau:note, or when the user asks to take a note / minute this / summarize where we are.
argument-hint: "[--workspace <name>]"
---

# Scribe — live minutes of the current session

`file-session` files the minutes *after* a session; the scribe writes them *during* it, so the
record's fidelity doesn't depend on end-of-session memory. It is the minute-taker; the filed
logbook entry is its notes cleaned up.

## Dual mode

- **In a bureau workspace** → append a running note to the session's logbook entry (it persists
  and `file-session` later finalizes it).
- **Anywhere else** → just hand the user the summary (ephemeral) — a useful "where are we" with
  no workspace required.

## When to run

On demand (`bureau:note`, or the user asking) or at **natural checkpoints** — a decision made,
a direction changed, a milestone reached. **Not after every turn**: constant summaries bury the
signal. Capture inflection points, not heartbeats.

## Steps

1. **Locate the workspace** (`bureau.json`; default `bureau`). If none, produce the summary for
   the user and stop (ephemeral mode) — do not error.
2. **Summarize the span** since the last note: the decisions reached, what changed, and the open
   threads. Faithful over polished — include reversals and dead ends.
3. **Append, don't rewrite.** Add the note to the session's running logbook entry
   (`logbook/<YYYY>/<MM>/<safe-session-id>.md`, the same file `file-session` finalizes), under a
   timestamped checkpoint heading. Never rewrite earlier notes or other sessions' entries.
4. **Stay low-authority.** Running notes are `status: logbook` — raw material, never canon. The
   scribe never writes cabinet pages.
5. **Report** the note's path (workspace mode) or present the summary (ephemeral mode).

## Rules

1. **Append-only.** Add checkpoints; never edit earlier ones. `file-session` consolidates them.
2. **Inflection points, not heartbeats.** Run at decisions/changes, not on a timer.
3. **No canon writes.** The scribe feeds the logbook only; cabinets are reached via compile.
4. **Sanitize the path.** Reuse the capture skill's safe-session-id rule for the file name.

## Examples

<example>
Context: Mid-session, a design decision was just made in a bureau repo.
user: "bureau:note"
assistant: "Noted to logbook/2026/06/<id>.md — checkpoint 14:30: decided to bundle the renderer rather than depend on it (reasons: one install, no node_modules); open thread: whether to retire the standalone repo. Earlier checkpoints untouched."
<commentary>A checkpoint is appended live to the running entry; file-session will consolidate the checkpoints at the end.</commentary>
</example>

<example>
Context: The user asks for a recap in a repo with no bureau workspace.
user: "summarize where we are"
assistant: "No bureau workspace here, so this is just for you: we compared three caching strategies and leaned toward write-through; still open is eviction policy."
<commentary>Outside a workspace the scribe summarizes ephemerally — useful, but it persists nothing.</commentary>
</example>

## Scope note

This skill covers ONLY live note-taking into the logbook (or an ephemeral summary). It does
**not** finalize the entry (`file-session`), **not** distil to cabinets (`compile`), and **not**
read the canon to answer questions (`recall` / `bureau:query`). It is invoked by `bureau:note`
and by the `SessionStart` (post-compaction) hook's re-grounding flow.
