// Coverage for features that shipped without their own test (audit residual gaps):
// disk-vs-declared drift (positive), assets bundle-budget, model.data discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildModel } from "../src/core/model.mjs";
import { deriveBacklinks } from "../src/derive/backlinks.mjs";
import { deriveHealth } from "../src/derive/health.mjs";
import { bundleReport } from "../src/services/assets.mjs";
import { buildSite } from "../src/build.mjs";
import { doc } from "./helpers.mjs";

function corpus({ config, docs = {}, data = {}, canvas = {} }) {
  const root = mkdtempSync(join(tmpdir(), "wb-extra-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify(config));
  for (const [n, b] of Object.entries(docs)) writeFileSync(join(docsDir, n), b);
  if (Object.keys(data).length || Object.keys(canvas).length) {
    mkdirSync(join(docsDir, "_data"), { recursive: true });
    for (const [n, b] of Object.entries(data)) writeFileSync(join(docsDir, "_data", n), b);
    for (const [n, b] of Object.entries(canvas)) writeFileSync(join(docsDir, n), b);
  }
  return { root, docsDir, dataDir: join(docsDir, "_data") };
}

test("health: disk-vs-declared drift fires when meta.expectedDocs ≠ actual", () => {
  const { docsDir } = corpus({
    config: { meta: { home: "", expectedDocs: 5 }, groups: [{ id: "g", label: "G" }] },
    docs: { "a.html": doc({ title: "A", group: "g" }), "b.html": doc({ title: "B", group: "g" }) },
  });
  const m = buildModel({ docsDir });
  const h = deriveHealth(m, deriveBacklinks(m), { now: "2026-06-09" });
  assert.equal(h.counts.drift, 1);
  assert.deepEqual(h.drift, [{ declared: 5, actual: 2 }]);
});

test("model: data + *.canvas files are discovered into model.data", () => {
  const { docsDir } = corpus({
    config: { meta: { home: "" }, groups: [{ id: "g", label: "G" }] },
    docs: { "a.html": doc({ title: "A", group: "g" }) },
    data: { "cold-events.md": "# x" },
    canvas: { "map.canvas": "{}" },
  });
  const m = buildModel({ docsDir }); // dataDir derives from docsDir/../data
  assert.ok(m.data.files.includes("cold-events.md"));
  assert.ok(m.data.canvas.includes("map.canvas"));
});

test("backlinks: a dangling wiki-link to an inherited key ([[constructor]]) does not crash the build", () => {
  // regression: inbound/outbound were plain {}, so inbound["constructor"]/["toString"] resolved
  // to a prototype member and `.includes` threw — killing every build that contained such a link.
  const model = { nodes: { A: {}, B: {} }, edges: [
    { source: "A", target: "B" },
    { source: "A", target: "constructor" }, // dangling — no such node
    { source: "B", target: "toString" },    // dangling inherited key
  ] };
  const bl = deriveBacklinks(model);           // must not throw
  assert.deepEqual(bl.inbound.B, ["A"]);
  assert.equal(bl.inbound.constructor, undefined); // no prototype leakage
});

test("assets: bundleReport sums bytes and stays under budget for a small board", () => {
  const { root, docsDir } = corpus({
    config: { meta: { home: "A" }, groups: [{ id: "g", label: "G" }] },
    docs: { "a.html": doc({ title: "A", group: "g" }) },
  });
  buildSite({ root, docsDir, outDir: join(root, "dist"), now: "2026-06-09" });
  const r = bundleReport(join(root, "dist"));
  assert.ok(r.totalBytes > 0);
  assert.equal(r.over, false);
  assert.ok(r.heaviest.length > 0 && r.heaviest[0].bytes > 0);
});
