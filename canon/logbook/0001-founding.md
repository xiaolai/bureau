---
title: session init · 2026-06-12
updated: 2026-06-12
status: logbook
---

# session init · 2026-06-12

**Intent.** Adopt bureau in bureau's own repository — the plugin keeps its durable knowledge in
the same shape it asks of every workspace it scaffolds.

**Decisions.** Keep this repo's durable knowledge in `canon/`: an append-only logbook of minutes,
plus reviewed cabinet pages compiled from them. Recorded as [[ADR 0001 — Adopt bureau]]; the
lexicon those pages speak is [[Glossary]].

**Open threads.** The canon starts small — the scaffold only. Later sessions capture minutes here
and `bureau:compile` distils them into cabinet pages.

**Note.** Filed by `bureau:init` when the workspace was created — not captured from a session
transcript. It is the founding minute: the origin the seeded cabinet pages cite.
