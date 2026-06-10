---
description: Answer a question from the bureau canon — cited, tier-aware, and never stating an unverified claim as fact.
argument-hint: "\"<question>\" [--workspace <name>]"
---

# bureau:query

Answer a question from the **cabinets** (the compiled canon), citing what you used and
respecting each claim's trust tier. This reads the maintained canon — it does NOT re-scan raw
sources.

If no question was given, ask the user what they want to know before proceeding.

Follow the protocol in the **recall** skill (`skills/recall/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. Find the cabinet pages that bear on the question (by title, drawer, and `[[links]]`); exclude
   `logbook/`, `board/`, `lint/`, and `_`-prefixed entries.
3. Synthesize an answer ONLY from those pages. For each claim you use, cite the page and its
   `status:` tier, and the `[[session …]]` provenance behind it.
4. **Never present a non-`canonical` claim as fact.** If the answer rests on `proposed`,
   `verified`, `stale`, or `contested` pages, say so explicitly and mark the uncertainty.
5. If the canon does not answer the question, say so plainly — do not invent. Note the gap
   (a `bureau:lint` gap finding, or a session worth filing).
6. Report the answer with its citations; offer to capture a notable new conclusion
   (`bureau:note`) so it enters the gate rather than being lost.

**Output format.** Prose answer with inline citations in the form `[Page title, <status>]`. If
any load-bearing claim is non-`canonical`, open with a bold warning line naming the weakest
tier relied on. End with a `Sources:` list of the pages used (title · status · `[[session]]`).
