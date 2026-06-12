import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildModel } from "../src/core/model.mjs";
import { deriveLayout } from "../src/derive/layout.mjs";
import { renderGraphSvg } from "../src/render/graph-svg.mjs";
import { canonicalJSON } from "../src/services/determinism.mjs";
import { doc } from "./helpers.mjs";

function model(docs) {
  const root = mkdtempSync(join(tmpdir(), "wb-layout-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "" }, groups: [{ id: "g", label: "G" }] }));
  for (const [n, m] of Object.entries(docs)) writeFileSync(join(docsDir, n), typeof m === "string" ? m : doc(m, "x"));
  return buildModel({ docsDir });
}

test("layout: deterministic + integer-quantized coordinates", () => {
  const m = model({ "a.html": { title: "A", group: "g" }, "b.html": { title: "B", group: "g" } });
  const a = deriveLayout(m), b = deriveLayout(m);
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  for (const n of Object.values(a.nodes)) {
    assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y), "coords quantized to integers");
  }
});

test("layout: reflow-free — adding a node does not move existing ones (the stability contract)", () => {
  const m1 = model({ "a.html": { title: "A", group: "g" }, "b.html": { title: "B", group: "g" } });
  const m2 = model({ "a.html": { title: "A", group: "g" }, "b.html": { title: "B", group: "g" }, "c.html": { title: "C", group: "g" } });
  const l1 = deriveLayout(m1).nodes, l2 = deriveLayout(m2).nodes;
  // note: region grid grows only past a slot threshold; within capacity, A/B keep their slots
  assert.deepEqual(l1["A"], l2["A"]);
  assert.deepEqual(l1["B"], l2["B"]);
});

test("graph-svg: node titles are escaped (XSS-safe)", () => {
  // title via data-title so it stays a literal string (an <h1> would strip the tag)
  const m = model({ "a.html": '<article data-group="g" data-title="<img src=x onerror=alert(1)>"></article>' });
  const svg = renderGraphSvg(deriveLayout(m), m);
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img/);
});
