---
name: capture
description: Write a faithful, append-only logbook entry for an AI session — intent, decisions, changed files, open threads, and a transcript pointer. Use when filing a session into a bureau workspace (e.g. via bureau:file-session), or when the user asks to record/minute the current session.
---

# Capture — session → logbook entry

A logbook entry is the **faithful, low-authority record** of one session: what was attempted,
what was decided, what changed, what's still open. It is the raw material the canon is later
compiled from, and the provenance every cabinet claim points back to. It is **append-only** —
write this session's entry; never edit another session's.

## Where it goes

`<workspace>/logbook/<YYYY>/<MM>/<safe-session-id>.md` (workspace name from `bureau.json`,
default `bureau`). **Sanitize the session id first** — keep only `[A-Za-z0-9_-]`, drop
everything else (no `/`, no `..`); fall back to `unknown` if empty. The raw session id is
untrusted and must never reach a filesystem path. If a mechanical `SessionEnd` stub already
exists at that path, **enrich it in place**: re-emit a clean frontmatter block (preserve
meaning, not the stub's raw bytes), then replace the body.

## Entry schema

Frontmatter is whiteboard's SIMPLE parser — it does NOT strip quotes and does NOT do YAML
escaping. So titles are **unquoted**, every value is a single safe line, and no value contains
`"`, a newline, or `[ ] |`.

```markdown
---
title: session <id8> · <YYYY-MM-DD>
updated: <YYYY-MM-DD>
status: logbook
session: <safe-session-id>
transcript: "<transcript path, JSON-escaped if present, else empty>"
---

## [<ISO-8601>] session <id8> — <one-line summary>

**Intent.** What this session set out to do (1–2 sentences).

**Decisions.**
- <decision> — implies cabinet page **<Page name>** (link with `[[Page]]` only if it already exists)

**Changes.**
- <path or artifact> (new | updated | removed) — <why>

**Open threads.**
- <unresolved question / next step>

**Source.** transcript `<path>`
```

## Rules

1. **Faithful over polished.** Record what actually happened, including dead ends and
   reversals — the logbook is history, not a press release.
2. **Decisions name their target — but don't ship dangling links.** Name the cabinet page a
   decision implies. Use a `[[link]]` ONLY if that page already exists; otherwise write the
   page name as plain text. `bureau:compile` creates the page and wires the provenance later.
3. **No canon writes.** Capture NEVER edits cabinet pages. Distillation into the SSOT is a
   separate, deliberate step (`bureau:compile`).
4. **Safe, unique title.** `session <id8> · <date>` is unique per session, unquoted, and free
   of `"` / `[ ] |`. The `<id8>` is the first 8 chars of the SANITIZED id.
5. **One session, one file.** Don't merge sessions; don't rewrite earlier entries.

## What this is NOT

Not a summary of the codebase, not a to-do list, not the truth. It is the **minutes of one
meeting**. Truth is adjudicated later, in the cabinets, under consistency checks.

## Examples

<example>
Context: A working session is wrapping up; the agent has full context.
user: "bureau:file-session"
assistant: "Filing this session. Logbook entry at logbook/2026/06/<id>.md — Intent: harden the capture script; Decisions: drop git from the hook (implies cabinet page **Capture design**); Changes: scripts/capture-stub.mjs; Open: none. I named the cabinet page in plain text since it doesn't exist yet — compile will create and link it."
<commentary>The rich entry is written in-session where context is live; a not-yet-existing target is plain text, not a dangling [[link]].</commentary>
</example>

<example>
Context: The SessionEnd hook already wrote a mechanical stub for this session.
user: "Record what we did this session into the logbook."
assistant: "A stub exists for this session, so I'll enrich it in place — re-deriving a clean sanitized frontmatter block and replacing the body with the full Intent/Decisions/Changes/Open entry."
<commentary>Enrichment preserves meaning, not the stub's raw bytes; other sessions' entries are never touched.</commentary>
</example>

## Scope note

This skill covers ONLY the logbook-capture protocol — turning one session into one faithful,
append-only logbook entry. It does **not** distil entries into cabinet pages (that is
`bureau:compile`), does **not** render or open the board (that is `bureau:inspect`), and does
**not** check consistency (that is `bureau:lint`).

Consumed by:
- the `bureau:file-session` command (writes the rich entry interactively, in-session);
- the `SessionEnd` hook → `scripts/capture-stub.mjs` (writes the mechanical stub this skill
  later enriches).
