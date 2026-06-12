---
name: recall
description: Answer from the bureau canon with citations and trust tiers — read dossiers as memory, honor each page's status, and never present an unverified claim as fact. Use when running bureau:query, or when the user asks what the project knows / what was decided / what the canon says about something.
argument-hint: "\"<question>\" [--workspace <name>]"
---

# Recall — read the canon, tier-aware

The cabinets are repo memory. Recall is the read side of the trust gate: it answers from the
**compiled canon** (not raw retrieval), cites what it used, and carries each claim's tier into
the answer so an unverified claim can never masquerade as fact.

## Steps

1. **Locate the workspace** (`bureau.json`; default `bureau`). If none, tell the user to run
   `bureau:init` first and stop.
2. **Find the pages that bear on it.** Search the cabinet drawers for pages on the question — by
   title, by drawer topic, and by following `[[links]]` between pages. EXCLUDE `logbook/`,
   `board/`, `lint/`, and every `_`-prefixed entry (those are history, output, or state, not
   canon).
3. **Answer only from those pages.** Synthesize a direct answer. Do NOT add knowledge the canon
   does not contain; if you must reason beyond it, mark that clearly as inference.
4. **Cite with tiers.** For each claim used, name the page, its `status:` (`canonical` /
   `verified` / `proposed` / `stale` / `contested`), and the `[[session …]]` provenance.
5. **Never state non-`canonical` as fact.** `canonical` is fact; `verified` is "checked, not
   approved"; `proposed`/`stale`/`contested` are claims to confirm — flag them in the answer.
6. **Name gaps.** If the canon does not cover the question, say so; do not fabricate. Suggest
   the next step (file a session, run `bureau:lint`).
7. **Offer to keep it.** If the synthesis reaches a conclusion worth remembering, offer to
   capture it (`bureau:note`) so it enters capture → compile → review, never straight to canon.

## Rules

1. **Compiled canon only.** Read dossiers; never re-derive an answer from raw sources or
   the logbook prose — that is what compile is for.
2. **Tier travels.** Every cited claim carries its `status:`; the answer's confidence is capped
   by its weakest load-bearing tier.
3. **No invention.** A gap is reported as a gap, not filled with a guess.
4. **Read-only.** Recall never edits cabinets; capturing a new conclusion goes through the gate.

## Examples

<example>
Context: A repo with a bureau canon; the user asks a settled question.
user: "bureau:query \"how long do auth tokens last?\""
assistant: "From **Token TTL** (`canonical`, sourced to session a1b2c3): auth tokens last 24h. That's an approved fact."
<commentary>A canonical page answers as fact, with the page, its tier, and its provenance cited.</commentary>
</example>

<example>
Context: the page that answers it is unreviewed.
user: "What did we decide about the queue retry policy?"
assistant: "The canon has **Queue retry** but it's `proposed` (unreviewed, from session d4e5f6) — so treat this as unverified: it says 3 retries with backoff. Want me to put it through bureau:review before you rely on it?"
<commentary>A non-canonical claim is answered WITH its tier and an explicit 'not fact yet' flag — never presented as settled.</commentary>
</example>

## Scope note

This skill covers ONLY reading the canon to answer a question. It does **not** capture sessions
(`capture` / `bureau:file-session`), **not** distil the logbook (`compile`), **not** approve
claims (`review`), and **not** render the gazette (`bureau:inspect`). It is invoked by the
`bureau:query` command, and auto-triggers when the user asks what the project knows.
