# ADR 0002 — the canvas projection (semantic zoom + the freshness map)

**Status:** accepted · **Date:** 2026-07-20 · **Supersedes nothing.** Extends the M3 graph view
(`derive/layout.mjs`, `render/graph-svg.mjs`) along the axis those modules already reserved:
*"the WebGL/semantic-zoom upgrade is gated on scale (>500 nodes)."*

## What this is — and what it is not

A **read-only projection** of the canon onto an unbounded pan/zoom surface. It is *derived output*:
rebuilt every build, gitignored, never authored. It writes nothing, so it touches no gate, needs no
write channel, and cannot forge a decision.

It is **not** a canvas editor. Dragging a node would be a durable write, and a durable write must go
through capture → compile → review — a human gate cannot run at interaction speed. That tension is
real, and the way out is to not create it: this surface only *shows*. Curated `.canvas` files
(ADR-less, M6) remain the separate, authored-elsewhere lane.

## Decision A — why this earns its place beside the Graph

The Graph shows **structure**; every tool with a link graph shows structure. bureau alone also knows,
per page, `trust` · `freshness` · `conflict` · `trustBy`/`trustAuthorized`. Painting *that* onto space
answers a question no link graph can:

> **Where is my canon rotting, and is the rot concentrated?**

Staleness clustered in one drawer is a different problem from staleness scattered across every drawer,
and the difference is only legible spatially. **The product is a freshness map, not a prettier graph.**

## Decision B — layout is inherited, not reinvented

`deriveLayout` already gives the property an infinite canvas lives or dies on: *"a node's slot is a
pure function of a stable hash of its id, so adding a node never moves existing ones"* — with
byte-stable quantized coordinates. A canvas is only a *place* if coordinates persist across builds;
a force simulation would reshuffle the map every time a page was added and destroy spatial memory.

So: **no new layout.** This ADR adds level-of-detail and state, nothing positional.

## Decision C — three LOD tiers, chosen by zoom scale

`attachPanZoom` clamps scale to `[0.4, 8]` and starts at a fitted baseline. The tiers:

| Tier | Scale | Shows | Answers |
|---|---|---|---|
| **far** | `s < 0.75` | region boxes, group labels, per-region counts; nodes as bare dots | "which *areas* are unhealthy?" |
| **mid** | `0.75 ≤ s < 2` | nodes + titles, filled by state (today's view, plus colour) | "which *pages*?" |
| **near** | `s ≥ 2` | nodes + title + trust tier + freshness label | "what exactly is wrong here?" |

**All three tiers are emitted into the one static SVG**, as `<g class="lod lod--far|mid|near">`. The
runtime sets `data-lod` on the host from the current scale and CSS reveals the matching tier. This
keeps the build artifact a pure function of its inputs, keeps rendering on the existing static-SVG
path, and needs no new runtime dependency.

**Degradation is deliberate:** with JavaScript off, `data-lod` is never set and CSS shows **mid** —
byte-for-byte today's graph. The projection is strictly additive.

## Decision D — colour encodes state, shape/stroke keeps grouping

Fill encodes the **worst** state a node is in (`stale` > `needs-review` > `modified` > `current`),
reusing the palette the meta-chips already use, so a colour means the same thing on the board and on
the map. A `canonical` page that is *unbacked* or *unauthorized* is flagged as its own state — an
unearned tier is a health problem, and this is the surface that makes it visible at a glance.

The deterministic per-group hue moves to the node **stroke**, so grouping stays readable without
competing with state for the fill channel.

## Decision E — scale stays gated exactly where it was

This is the **SVG** path and it does not attempt to solve scale. The `>500 nodes` WebGL/semantic-zoom
gate stands untouched. LOD reduces *ink* at low zoom; it does not reduce *DOM*, so a very large canon
still wants the gated renderer. Nothing here forecloses it — the tiers and the state contract are the
same data a WebGL path would consume.

## Schema — the state contract

`renderGraphSvg(layout, model, state)`. `state` is optional; omitted ⇒ today's uncoloured render.

```jsonc
{
  "<node key>": {
    "freshness": "current|needs-review|stale|modified", // from engine/live.mjs (working-tree aware)
    "trust":     "proposed|verified|canonical|null",    // authored/projected tier
    "flag":      "unbacked|unauthorized|null"           // a canonical tier nothing accepted backs
  }
}
```

Sourced in `build.mjs` from the **same** `liveFreshness` snapshot the badges and the Health page use,
so the map can never disagree with the rest of the board.

## Honest limits

- **Not in the fsck fixpoint.** The rendered board is regenerable output; only engine-derived state
  (`_gate.json`) is fixpoint-checked. The *layout* is byte-stable; the *SVG* is not a trust artifact.
- **Freshness is working-tree aware**, so the map (like the badges) shifts as you edit, before you
  `scan`. That is the live board's established contract, not a new one.
- **LOD is ink, not DOM.** See Decision E.
- **`.canvas` files are untouched.** Curated canvases stay read-only, un-tiered, and outside the canon.
