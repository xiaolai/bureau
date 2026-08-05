// WI-8 (ADR layer) — the decision-filtered board view. Reuses deriveLayout + renderGraphSvg; the
// layout change (preserve edgeType) is ADDITIVE, so the main graph is byte-identical, and the decision
// view filters to the ADR subgraph and styles supersedes distinctly. Hand-built models; no fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLayout } from "../src/derive/layout.mjs";
import { renderGraphSvg, renderDecisionView } from "../src/render/graph-svg.mjs";

function mkModel(nodeDefs, edgeDefs) {
  const nodes = {};
  for (const n of nodeDefs) nodes[n.title] = { id: n.title, uid: n.uid || n.title, title: n.title, kind: n.kind ?? null, group: n.group ?? "g" };
  const edges = edgeDefs.map(([source, target, edgeType]) => ({ source, target, edgeType, tracked: edgeType === "rests_on" }));
  return { nodes, edges, nodeCount: nodeDefs.length };
}
const countOf = (s, sub) => s.split(sub).length - 1;

test("8.2 the MAIN graph SVG ignores edgeType (additive: default render identical whether or not edgeType is present)", () => {
  const m = mkModel([{ title: "A", group: "g" }, { title: "B", group: "g" }], [["A", "B", "supersedes"], ["A", "B", "rests_on"]]);
  const layout = deriveLayout(m);
  const stripped = { ...layout, edges: layout.edges.map((e) => ({ source: e.source, target: e.target })) };
  assert.equal(renderGraphSvg(layout, m), renderGraphSvg(stripped, m), "the default renderer must not consume the new edgeType key");
  assert.ok(!renderGraphSvg(layout, m).includes("wb-edge-"), "no decision styling leaks into the main graph");
});

test("8.3 the decision view renders ONLY ADR nodes and their supersedes/rests_on edges", () => {
  const m = mkModel(
    [{ title: "ADR One", kind: "adr" }, { title: "ADR Two", kind: "adr" }, { title: "Plain Page", kind: null }],
    [["ADR One", "ADR Two", "supersedes"], ["ADR Two", "Plain Page", "rests_on"], ["ADR One", "ADR Two", "contradicts"]],
  );
  const svg = renderDecisionView(m);
  assert.ok(svg.includes("ADR One") && svg.includes("ADR Two"), "ADR nodes are present");
  assert.ok(!svg.includes("Plain Page"), "non-ADR nodes are excluded");
  // only the ADR↔ADR supersedes edge is drawable: rests_on points at a non-ADR, contradicts is not a decision edge
  assert.equal(countOf(svg, "<line "), 1);
});

test("8.4 a supersedes edge renders visually distinct from a rests_on edge", () => {
  const m = mkModel(
    [{ title: "ADR One", kind: "adr" }, { title: "ADR Two", kind: "adr" }, { title: "ADR Three", kind: "adr" }],
    [["ADR One", "ADR Two", "supersedes"], ["ADR Two", "ADR Three", "rests_on"]],
  );
  const svg = renderDecisionView(m);
  assert.ok(svg.includes('class="wb-edge-supersedes"'), "the supersedes edge carries its type class");
  assert.ok(svg.includes('class="wb-edge-rests_on"'), "the rests_on edge carries its type class");
  assert.equal(countOf(svg, "stroke-dasharray"), 1, "only the supersedes edge is dashed");
});

test("8.5 an effectively-superseded ADR is coloured by its superseded state", () => {
  const m = mkModel([{ title: "ADR Old", kind: "adr" }, { title: "ADR New", kind: "adr" }], [["ADR New", "ADR Old", "supersedes"]]);
  const svg = renderDecisionView(m, { "ADR Old": { superseded: true }, "ADR New": { trust: "canonical" } });
  assert.ok(svg.includes("var(--ink-faint"), "the superseded node uses the distinct superseded fill");
});
