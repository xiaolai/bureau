---
description: Distil logbook entries into consistency-checked cabinet pages (the canon), with provenance back to each session.
argument-hint: "[--since <YYYY-MM-DD>] [--workspace <name>]"
---

# bureau:compile

Turn the append-only logbook into canon: read the sessions that haven't been compiled yet and
distil their claims into **cabinet pages** — the consistency-checked SSOT — each linked back to
the logbook entry that introduced it.

Follow the protocol in the **compile** skill (`skills/compile/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. Select logbook entries not yet in `_compile-state.json` (narrow with `--since <date>`). If
   none remain, report "cabinets already current" and stop.
3. For each entry, extract its decisions/changes into claims, place each on its target cabinet
   page (creating the page in the matching drawer when absent), and add the session to the
   page's body `**Sources.**` provenance line.
4. On disagreement with an existing canonical claim, apply the conflict policy — set the page
   `status: contested`, keep both claims with their provenance, add a `contradicts:` edge, and
   name it in the report. Never overwrite silently.
5. Record processed session ids in `_compile-state.json`, then run `bureau:inspect` for the
   structural check.
6. Report pages created, pages updated, and any contested pages, with how to inspect them.
