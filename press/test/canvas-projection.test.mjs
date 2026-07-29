// The canvas projection (ADR-0002): semantic-zoom LOD tiers + the freshness map.
// Renders from hand-built layout/model/state so it isolates the render layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGraphSvg, nodeState } from "../src/render/graph-svg.mjs";
import { deriveLayout } from "../src/derive/layout.mjs";

const model = {
  nodes: {
    Alpha: { title: "Alpha", group: "decisions", trust: "canonical" },
    Beta: { title: "Beta", group: "decisions", trust: "proposed" },
    Gamma: { title: "Gamma", group: "logbook", trust: "verified" },
  },
  edges: [{ source: "Alpha", target: "Beta" }],
  nodeCount: 3,
};
const layout = deriveLayout(model);

test("projection: all three LOD tiers ship in the one static SVG", () => {
  const svg = renderGraphSvg(layout, model, null);
  for (const t of ["lod--far", "lod--mid", "lod--near"]) assert.match(svg, new RegExp(t));
  assert.match(svg, /class="wb-canvas"/); // the CSS hook the runtime keys off
});

test("projection: omitting state renders exactly as before (strictly additive)", () => {
  // the mid tier is the pre-ADR view; with no state every node paints the neutral `current` fill
  const svg = renderGraphSvg(layout, model);
  assert.match(svg, /Alpha/);
  assert.doesNotMatch(svg, /needs-review|unbacked|unauthorized/);
});

test("projection: fill encodes the WORST state, and a flag outranks freshness", () => {
  assert.equal(nodeState(null), "current");
  assert.equal(nodeState({ freshness: "current" }), "current");
  assert.equal(nodeState({ freshness: "needs-review" }), "needs-review");
  assert.equal(nodeState({ freshness: "stale" }), "stale");
  // an unearned canonical tier is a TRUST problem — it must not be masked by a benign freshness
  assert.equal(nodeState({ freshness: "current", flag: "unbacked" }), "unbacked");
  assert.equal(nodeState({ freshness: "needs-review", flag: "unauthorized" }), "unauthorized");
});

test("projection: the far tier summarizes each region and counts what needs attention", () => {
  const state = {
    Alpha: { freshness: "stale", trust: "canonical", flag: null },
    Beta: { freshness: "current", trust: "proposed", flag: null },
    Gamma: { freshness: "current", trust: "verified", flag: null },
  };
  const far = renderGraphSvg(layout, model, state).split('class="lod lod--far"')[1].split("</g>")[0];
  assert.match(far, /decisions · 1\/2 need attention/); // 1 of 2 in the decisions region
  assert.match(far, /logbook · 1/);                      // healthy region shows a bare count
  assert.doesNotMatch(far, /Alpha/);                     // far tier drops per-node labels
});

test("projection: the near tier names the tier and the problem", () => {
  const state = { Alpha: { freshness: "needs-review", trust: "canonical", flag: null } };
  const near = renderGraphSvg(layout, model, state).split('class="lod lod--near"')[1].split("</svg>")[0];
  assert.match(near, /Alpha/);
  assert.match(near, /canonical · needs-review/); // tier AND state, so the fix is obvious
});

test("projection: a hostile title cannot inject markup into any tier", () => {
  const hostile = {
    nodes: { "x": { title: '<script>alert(1)</script>', group: "g", trust: "canonical" } },
    edges: [], nodeCount: 1,
  };
  const svg = renderGraphSvg(deriveLayout(hostile), hostile, { x: { freshness: "stale", flag: "unbacked" } });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("projection: a hostile group name cannot inject markup into the far tier", () => {
  const hostile = {
    nodes: { a: { title: "A", group: '"><script>x</script>', trust: null } },
    edges: [], nodeCount: 1,
  };
  const svg = renderGraphSvg(deriveLayout(hostile), hostile, null);
  assert.doesNotMatch(svg, /<script>x<\/script>/);
});

test("projection: output is deterministic — same inputs, byte-identical SVG", () => {
  const state = { Alpha: { freshness: "stale", trust: "canonical", flag: null } };
  assert.equal(renderGraphSvg(layout, model, state), renderGraphSvg(layout, model, state));
  // and region boxes are emitted in sorted order, so group iteration can't perturb bytes
  const svg = renderGraphSvg(layout, model, state);
  assert.ok(svg.indexOf("decisions ·") < svg.indexOf("logbook ·"));
});

test("projection: a node with no state entry is treated as current, not undefined", () => {
  const svg = renderGraphSvg(layout, model, { Alpha: { freshness: "stale" } }); // Beta/Gamma absent
  assert.doesNotMatch(svg, /undefined/);
});
