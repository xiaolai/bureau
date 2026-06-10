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
2. Select logbook entries not yet in `<workspace>/_compile-state.json` (narrow with
   `--since <date>`). If none remain, report "cabinets already current" and stop.
3. For each entry, extract its decisions/changes into claims, place each on its target cabinet
   page — one claim per page, enforcing the title rules (unique, unquoted, no `[ ] |`),
   creating the page in the matching drawer when absent — and add the session to the page's
   body `**Sources.**` provenance line.
4. Set each page's trust tier: a claim checkable against the repo (a path, command, signature,
   config value, dep, commit) is confirmed — **resolve every path and confirm it stays inside
   the repo/workspace first** — and if it holds, set `status: verified` and record the
   `{artifact, hash}` in `<workspace>/_verify.json` (keyed by page title). Everything else stays
   `status: proposed`. Never write `canonical` (that is `bureau:review`).
5. On disagreement with an existing claim, apply the conflict policy — set the page
   `status: contested`, keep both claims with their provenance, add a reciprocal single-line
   `contradicts: [[Other page]]` edge (a comma list for 2+ items, deduped; never a YAML list),
   and name it in the report. Never overwrite silently.
6. Run `bureau:inspect` for the structural check; ONLY on success record the processed session
   ids in `<workspace>/_compile-state.json` (a failed build leaves them un-compiled for retry).
7. Report pages created, pages updated, pages left `proposed` (awaiting `bureau:review`), and
   any contested pages, with how to inspect them.
