---
title: Glossary
updated: 2026-06-12
status: proposed
---

# Glossary

bureau's lexicon is one coherent picture: **a records office that publishes a gazette.** The nouns
below are deliberately rare in dev-speak, so each names exactly one thing; the verbs that act on
them stay plain (*build*, *file*, *review*, *check*, *ask*).

| Term | What it is |
|---|---|
| **bureau** | the engine you run (the office) |
| **gazette** | the published board you build and open (`bureau:inspect`) — the thing you read |
| **press** | the bundled renderer that builds the gazette (internal; you never touch it) |
| **canon** | your body of approved knowledge |
| **cabinet** | where the canon is filed; its **drawers** are categories |
| **dossier** | one topic's page in the canon |
| **logbook** | the append-only session history; one session's entry is a **minute** |
| **crew** | the specialized agents you can enable; one is a **desk** (e.g. the *audit desk*) |
| **docket** | the "what's still pending" view (`bureau:status`) |
| **provenance** | a dossier's sourcing — every claim links back to the minute that introduced it |

**Trust tiers** (a dossier's `status:`): `proposed` → `verified` → `canonical`, plus `stale` and
`contested`. Only a human ratifies a claim to `canonical` (via `bureau:review`).

**Reserved dirs in a repo:** `bureau/` (the control plane — the crew lives at `bureau/crew/`),
`gazette/` (the rendered output), `board`/`crew` — none of these can be the workspace name.

**Sources.** [[Overview]]
