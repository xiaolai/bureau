---
title: session architecture · 2026-06-11
updated: 2026-06-11
status: logbook
session: architecture
transcript: ""
---

## [2026-06-11] session architecture — bureau's shape and gate

**Intent.** Solve the pain: AI sessions are unrecorded meetings, and natural-language docs
drift / contradict / go stale. Build a human-inspectable archive that doubles as trustworthy
repo memory.

**Decisions.**
- The umbrella is **bureau** (the office). Components self-name from the metaphor: cabinets
  (the canon), logbook (history), and a dashboard (gazette). — implies cabinet page **Engine, renderer, workspace**
- Two artifacts, not one: the **wiki/cabinets** is overwritten to stay consistent (current
  truth); the **logbook** is append-only (provenance). Opposite update semantics — keep them
  separate. — implies cabinet page **Engine, renderer, workspace**
- The whole thing follows Karpathy's LLM-wiki pattern (LLM as compiler, not retriever) plus
  session provenance and a human review gate. — implies cabinet page **Trust tiers and the review gate**
- Name: chose **bureau** over **office** (generic); the dashboard later named **gazette**.

**Changes.**
- The bureau plugin: commands (init/note/file-session/compile/review/lint/query/status/inspect)
  + skills (capture/scribe/compile/review/lint/recall) + a SessionEnd/SessionStart hook.

**Open threads.**
- Lint finder/verifier agents deferred until there's a real corpus to tune on.

**Source.** this session.
