import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildModel } from "../src/core/model.mjs";
import { deriveLayout } from "../src/derive/layout.mjs";
import { renderGraphSvg } from "../src/render/graph-svg.mjs";
import { canonicalJSON } from "../src/services/determinism.mjs";
import { doc } from "./helpers.mjs";

function model(docs, t) {
  const root = mkdtempSync(join(tmpdir(), "wb-layout-"));
  if (t) t.after(() => rmSync(root, { recursive: true, force: true }));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "" }, groups: [{ id: "g", label: "G" }] }));
  for (const [n, m] of Object.entries(docs)) writeFileSync(join(docsDir, n), typeof m === "string" ? m : doc(m, "x"));
  return buildModel({ docsDir });
}

test("layout: deterministic + integer-quantized coordinates", (t) => {
  const m = model({ "a.html": { title: "A", group: "g" }, "b.html": { title: "B", group: "g" } }, t);
  const a = deriveLayout(m), b = deriveLayout(m);
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  for (const n of Object.values(a.nodes)) {
    assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y), "coords quantized to integers");
  }
});

test("layout: reflow-free — adding a node does not move existing ones (the stability contract)", (t) => {
  const m1 = model({ "a.html": { title: "A", group: "g" }, "b.html": { title: "B", group: "g" } }, t);
  const m2 = model({ "a.html": { title: "A", group: "g" }, "b.html": { title: "B", group: "g" }, "c.html": { title: "C", group: "g" } }, t);
  const l1 = deriveLayout(m1).nodes, l2 = deriveLayout(m2).nodes;
  // note: region grid grows only past a slot threshold; within capacity, A/B keep their slots
  assert.deepEqual(l1["A"], l2["A"]);
  assert.deepEqual(l1["B"], l2["B"]);
});

test("graph-svg: node titles are escaped (XSS-safe)", (t) => {
  // title via data-title so it stays a literal string (an <h1> would strip the tag)
  const m = model({ "a.html": '<article data-group="g" data-title="<img src=x onerror=alert(1)>"></article>' }, t);
  const svg = renderGraphSvg(deriveLayout(m), m);
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img/);
});

test("layout: no two nodes in a group share coordinates (hash collisions resolved)", () => {
  // hash32(id) % side² collides for some ids; without probing two nodes would render on top of
  // each other, hiding one. Force 60 nodes into one group and assert every slot is distinct.
  const nodes = {};
  for (let i = 0; i < 60; i++) nodes["n" + i] = { id: "n" + i, group: "g", title: "n" + i };
  const lay = deriveLayout({ nodes, edges: [] });
  const coords = new Set(Object.values(lay.nodes).map((n) => n.x + "," + n.y));
  assert.equal(coords.size, 60, "every node must occupy a distinct cell");
});

test("layout: deterministic — same model twice gives identical coordinates", () => {
  const nodes = {}; for (let i = 0; i < 20; i++) nodes["n" + i] = { id: "n" + i, group: "g", title: "n" + i };
  const a = deriveLayout({ nodes, edges: [] }), b = deriveLayout({ nodes, edges: [] });
  assert.deepEqual(a.nodes, b.nodes);
});
