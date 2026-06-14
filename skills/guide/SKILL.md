---
name: guide
description: Orientation for the bureau plugin — the records-office model, the capture → compile → review gate, the trust tiers, the crew, and which bureau: command serves which intent. Read this FIRST before using any bureau: command, or whenever working in a repo that has a bureau workspace (a canon/ directory + a BUREAU.md), so you draw on the project's canon instead of re-deriving or guessing.
---

# Bureau — how to use this plugin

Bureau turns AI sessions into a **maintained, human-reviewed knowledge base** for a repo. This
skill is the map: the mental model, the one workflow, the invariants you must not break, and a
decision table from *intent* → *command*. Read it before reaching for any `bureau:` command, then
drop into the operational skill for the step you're on.

## The mental model — a records office

Think of a government records office, and keep the metaphor straight because every command name
comes from it:

- **bureau** — the engine (this plugin). It files, distils, and publishes knowledge.
- **canon** — the workspace: the durable knowledge for *this* repo (default dir `canon/`).
- **logbook** — an append-only drawer of **minutes**: one faithful, low-authority record per
  session. History, never rewritten.
- **cabinets** — topic **drawers** holding **dossiers** (the reviewed pages). This is the canon you
  read as memory.
- **press** — the bundled renderer. **gazette** — what the press produces: a navigable offline
  board you open in a browser.
- **crew** — specialized agents (each one a **desk**) that work the canon; e.g. an `auditor` desk.
- **provenance** — every dossier claim traces back to the `[[session …]]` minute it came from.

A claim's life: it is **captured** into a minute (low authority) → **compiled** into a dossier
(machine-checked) → **reviewed** by a human (promoted to fact). Knowledge only earns authority by
moving through that pipeline. Nothing skips it.

## The trust tiers — read every dossier's `status:`

Every dossier carries a `status:`. When you use one as memory, **honor the tier and cite it**:

| Tier | Means | How to treat it |
|------|-------|-----------------|
| `canonical` | A human approved it | **Fact.** |
| `verified` | Auto-checked against the repo, not yet approved | Usable; reconfirm if load-bearing. |
| `proposed` | Compiled but unchecked | **Not fact** — verify before relying. |
| `stale` | Was canonical, repo moved past it | **Not fact** — re-derive. |
| `contested` | Sources disagree | **Not fact** — surface the conflict. |

Never present a non-`canonical` claim as settled. The tier travels with the claim — if you cite a
dossier, cite its tier too. `bureau:query` enforces this for you, which is why you should query the
canon rather than reading dossier files raw.

## The invariants — do not break these

1. **Never write `canonical` yourself.** Only a human, via `bureau:review`, promotes a claim to
   fact. Setting `canonical` by hand forges the gate.
2. **Never hand-edit a dossier.** Durable claims enter only through capture → compile → review.
   Editing a cabinet page directly bypasses provenance and the human gate.
3. **The logbook is append-only.** Add minutes; never rewrite or delete a past one.
4. **Never hand-edit the materialized crew** under `.claude/agents/` or `.claude/skills/` — those
   carry a bureau-generated ownership marker and are regenerated. Edit the source in `bureau/crew/<name>/`
   and re-sync.
5. **Reach for the canon before re-deriving.** If the repo may have already settled something,
   `bureau:query` first.

## Which command for which intent

| You want to… | Run | Backed by skill |
|--------------|-----|-----------------|
| Set bureau up in this repo | `bureau:init` | — |
| Ask what the project knows / what was decided | `bureau:query` | `recall` |
| Jot a durable point mid-session | `bureau:note` | `scribe` |
| File the whole current session as a minute | `bureau:file-session` | `capture` |
| Distil minutes into dossiers | `bureau:compile` | `compile` |
| Find contradictions / stale / unsupported claims | `bureau:lint` | `lint` |
| Promote vetted claims to `canonical` (human gate) | `bureau:review` | `review` |
| See uncompiled sessions + pages by tier | `bureau:status` | — |
| Build and open the gazette | `bureau:inspect` | — |
| Open the interactive chamber (serve + intake) | `bureau:serve` | — |
| List / enable / author crew desks | `bureau:crew` | — |

The right-hand skills hold the operational detail (steps, rules, edge cases) — this guide does not
restate them; open the skill for the step you're actually doing.

## When to reach for bureau (and when not)

- **Use it** in a repo that has a `canon/` + `BUREAU.md`: query before deciding something the repo
  may have settled; capture before a session ends; compile/review to keep the canon current.
- **Don't** treat raw dossier files as fact, route durable knowledge around the gate, or render the
  gazette into the workspace. **Don't** use bureau as a scratchpad — minutes are a faithful record,
  not a TODO list.

## Chamber

`bureau:serve` opens the **chamber** — a single-user, localhost-only room that serves the gazette
read-only, accepts **intake** (a proposed claim files as an append-only `status: logbook` minute),
and hosts the **review/dispose** surface. The boundary is structural: **propose is open** (the human
or a convened AI desk POSTs intake), **dispose is the human's act** — promoting a dossier to
`canonical` requires a reviewer token printed to the `bureau:serve` terminal, which the AI's agent
context never sees. So the chamber proposes (logbook) and a human disposes (canonical); it never lets
the AI seat forge a higher tier.

## Crew

A repo can run **desks** — read-only or task-specific agents over its canon. The shipped `auditor`
desk reviews the canon for contradictions, stale claims, and unsupported `canonical`/`verified`
pages, and only *reports* (findings still go through the gate). Manage desks with `bureau:crew`;
their source lives in `bureau/crew/<name>/` and is materialized into `.claude/` on sync.

## Examples

<example>
Context: An AI is about to make an architecture choice in a repo that has a canon/ + BUREAU.md.
assistant: "This repo runs bureau. Before deciding, I'll `bureau:query \"how do we handle retries?\"` — the canon may have already settled this, with a trust tier, so I don't re-derive it."
<commentary>The guide's first reflex: consult the canon (tier-aware) before guessing.</commentary>
</example>

<example>
Context: A session just resolved a real constraint and is wrapping up.
assistant: "That's durable. I'll `bureau:note` it now so it lands in the logbook as a minute — it'll become a dossier on the next `bureau:compile`, and a human promotes it via `bureau:review`. I won't write it straight into a cabinet or mark it canonical."
<commentary>Capture is cheap; the claim moves through the gate, never around it.</commentary>
</example>

## Scope note

This skill is **orientation only** — the plugin's mental model, invariants, and the intent→command
map. It does not itself capture (`capture`/`scribe`), compile (`compile`), answer from the canon
(`recall`), promote claims (`review`), lint, or render. Open the per-step skill for that work. Keep
this guide in lockstep with the command surface: the static gate fails if a `bureau:` command exists
that this guide doesn't name, or if it names one that no longer exists.
