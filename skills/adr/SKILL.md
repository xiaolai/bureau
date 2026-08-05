---
name: adr
description: Record an architecture decision as a MADR ADR page in the canon. Use when running bureau:adr, or when the user asks to write/record an ADR or an architecture decision, or to supersede a prior decision. Authors a proposed page only — never approves.
argument-hint: "\"<title>\" [--supersedes <ADR-N>] [--workspace <name>]"
---

# ADR — record an architecture decision (MADR)

An ADR is a durable decision record. bureau treats it as an ordinary cabinet page carrying
`kind: adr`, so it flows through the same trust gate as every other claim — **capture → review**.
This skill authors the page; a human ratifies it.

## The write-gate (non-negotiable)

`bureau:adr` **authors a `proposed` page only.** It MUST NOT:

- run `gazette approve` / `confirm` / `resolve` (nor `bureau:review`'s promote/confirm/resolve steps),
- pass `--by human`, a person's name, or omit `--by` so an event records as human,
- author `status: canonical` / `trust: canonical` / any approval marker into the page.

An ADR becomes fact only when a **human** approves it through `bureau:review`. A `supersedes` edge takes
effect only once the superseding ADR is itself approved and content-current (ADR-0006) — so a freshly
scaffolded ADR supersedes nothing until a human approves it. Do not imply otherwise to the user.

## Steps

1. **Locate the workspace** — a single `*/bureau.json` child of the cwd, else `canon`. If none, tell
   the user to run `bureau:init` and stop.
2. **Scaffold via the press** — never hand-template the page or hand-compute the number. Run
   `gazette adr new`, passing each argument as its own token (no shell interpolation of the title):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" adr new --title "<title>" [--supersedes <ADR-N>] --dir <workspace>
   ```

   `--supersedes` takes an `ADR-N` token or the exact title of an existing ADR; the verb resolves it to
   that page's title. An unresolved target fails loudly and writes nothing — surface the error, never
   retry with a fabricated title.
3. **Fill the MADR body from the session** — replace the section placeholders with the real Context and
   Problem Statement, Decision Drivers, Considered Options, the chosen Decision Outcome (with its
   justification), Consequences (good / bad / neutral), and the **Confirmation** (how the decision is
   verified — name the artifact and the `gazette ledger verify` command that fingerprints it, so a later
   drift re-flags this ADR for review). Edit the body prose only.
4. **Report** the path and assigned number, and state it is **`proposed` and awaits `bureau:review`**.
   If it supersedes another ADR, add that the supersession activates only when a human approves this ADR.

## Why route through the gate

A superseding ADR that took effect the moment an AI wrote it could silently retire a canonical decision
no human re-read. bureau forbids that: the supersession stays inert until the superseding ADR is
approved AND its reviewed bytes still match (content-binding). This skill's job ends at a well-formed
`proposed` page; the human's approval is what makes it — and any supersession — real.

## Examples

<example>
Context: In a bureau repo, the team just chose an approach after weighing options.
user: "bureau:adr record that we're going with content-bound supersession over mere-approval"
assistant: "Scaffolded decisions/ADR-0007-content-bound-supersession.md (ADR-0007, proposed). I filled the Context, the two considered options (mere-approval vs fresh-approval) and the chosen Decision Outcome with its justification, the Consequences, and a Confirmation naming the fsck test that fingerprints it. It's `proposed` and awaits `bureau:review` — I did not approve it."
<commentary>The skill authors a proposed page and fills the MADR body from the session; a human promotes it via bureau:review. It never approves.</commentary>
</example>

<example>
Context: A new decision replaces an accepted one.
user: "write an ADR that supersedes ADR-0003"
assistant: "Created decisions/ADR-0008-… (proposed) with a `supersedes` edge to ADR-0003's title. The supersession takes effect only once a human approves ADR-0008 and its bytes still match — until then ADR-0003 stays current fact."
<commentary>--supersedes resolves the ADR token to the target's title; the supersession is inert until the superseding ADR is approved (ADR-0006).</commentary>
</example>

## Scope note

This skill covers ONLY scaffolding a `proposed` MADR ADR page (and filling its body from the session).
It does **not** approve, confirm, or resolve — that is the human gate (`bureau:review`) — **not** distil
minutes into cabinets (`bureau:compile`), and **not** read the canon to answer questions
(`bureau:query` / `recall`). It authors one page; the human's approval is what makes it, and any
supersession, real.

## Known limitation

`gazette ledger verify` keys the Confirmation artifact by the ADR's **title**. Renaming the ADR after
recording a Confirmation loses the link (the ledger is not migrated on rename). The `ADR-NNNN` prefix
rarely changes, which keeps this stable in practice; if you must rename, re-run `ledger verify`.
