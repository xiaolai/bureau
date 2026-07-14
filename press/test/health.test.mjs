import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";
import { GOLDEN_DOCS, FIXED_NOW } from "./helpers.mjs";
import { buildModel } from "../src/core/model.mjs";
import { deriveBacklinks } from "../src/derive/backlinks.mjs";
import { deriveHealth, healthTotal } from "../src/derive/health.mjs";
import { canonicalJSON } from "../src/services/determinism.mjs";

function golden() {
  const m = buildModel({ docsDir: GOLDEN_DOCS });
  return deriveHealth(m, deriveBacklinks(m), { now: FIXED_NOW });
}

test("health: detects exactly the injected drift cases (100% + no false positives)", () => {
  const h = golden();
  assert.deepEqual(h.counts, { dangling: 1, orphan: 1, contradiction: 1, invalidDate: 0, stale: 1, schema: 1, drift: 0, unsourced: 0 });
});

test("health: a _types violation is flagged (Villain.rival not in the character schema)", () => {
  assert.deepEqual(golden().schema, [{ kind: "unknownEdge", node: "Villain", key: "rival" }]);
});

test("health: dangling is the renamed link Hero -> OldName", () => {
  assert.deepEqual(golden().dangling, [{ source: "Hero", target: "OldName", edgeType: null }]);
});

test("health: orphan is Orphan", () => {
  assert.deepEqual(golden().orphan, [{ node: "Orphan" }]);
});

test("health: contradiction is the typed Hero <-> Villain pair", () => {
  assert.deepEqual(golden().contradiction, [{ a: "Hero", b: "Villain" }]);
});

test("health: stale is Stale with newer neighbor Hero", () => {
  assert.deepEqual(golden().stale, [{ node: "Stale", updated: "2026-01-01", newerNeighbor: "Hero" }]);
});

test("health: no findings when now is far in the past (nothing stale) is still deterministic", () => {
  const a = canonicalJSON(golden());
  const b = canonicalJSON(golden());
  assert.equal(a, b);
});

test("health: matches the committed golden oracle (examples/golden/expected/health.json)", () => {
  const expected = readFileSync(resolve(GOLDEN_DOCS, "..", "expected", "health.json"), "utf8");
  assert.equal(canonicalJSON(golden()) + "\n", expected);
});

// ── unsourced lane ────────────────────────────────────────────────────────────
// The trap this lane exists to close: the source drawer links OUT to the claims, so the
// graph is fully connected — zero dangling, zero orphans — while not one claim links BACK
// to the minute that justifies it. Health used to call that a clean bill.
function provModel({ provenance } = {}) {
  const n = (id, group, status) => ({ id, title: id, group, status, updated: "2026-06-12", icon: "file", file: id + ".md", attrs: {} });
  const nodes = {
    Logbook: n("Logbook", "logbook", "logbook"),        // the drawer's index page
    "minute-1": n("minute-1", "logbook", "logbook"),    // an actual minute
    Sourced: n("Sourced", "decisions", "proposed"),
    IndexOnly: n("IndexOnly", "decisions", "canonical"),
    Sibling: n("Sibling", "decisions", "verified"),
    Untiered: n("Untiered", "decisions", null),         // no trust tier → not a claim
  };
  const edges = [
    { source: "Sourced", target: "minute-1", edgeType: null },   // real provenance
    { source: "IndexOnly", target: "Logbook", edgeType: null },  // only the drawer index — NOT provenance
    { source: "Sibling", target: "Sourced", edgeType: null },    // a sibling claim — NOT provenance
    { source: "Untiered", target: "Sourced", edgeType: null },
    { source: "Logbook", target: "Sourced", edgeType: null },    // drawer links outward: the false-green trap
    { source: "minute-1", target: "Sourced", edgeType: null },
  ];
  const meta = provenance === undefined
    ? { provenance: { requireFor: ["proposed", "verified", "canonical"], sourceGroup: "logbook", exclude: ["Logbook"] } }
    : (provenance === null ? {} : { provenance });
  const model = { nodes, edges, types: {}, meta };
  return deriveHealth(model, deriveBacklinks(model), { now: FIXED_NOW });
}

test("health: unsourced flags a claim with no link back into the source drawer", () => {
  assert.deepEqual(provModel().unsourced, [
    { node: "IndexOnly", status: "canonical" },
    { node: "Sibling", status: "verified" },
  ]);
});

test("health: a claim citing a real minute is not unsourced", () => {
  assert.ok(!provModel().unsourced.some((u) => u.node === "Sourced"));
});

test("health: linking only the drawer's index page is NOT provenance (exclude)", () => {
  assert.ok(provModel().unsourced.some((u) => u.node === "IndexOnly"), "the [[Logbook]] index must not satisfy the check");
});

test("health: pages without a trust tier are not claims, so never unsourced", () => {
  assert.ok(!provModel().unsourced.some((u) => u.node === "Untiered"));
});

test("health: pages inside the source drawer are their own provenance", () => {
  const u = provModel().unsourced.map((x) => x.node);
  assert.ok(!u.includes("Logbook") && !u.includes("minute-1"));
});

test("health: the unsourced lane is inert without a _config provenance block (generic press)", () => {
  assert.deepEqual(provModel({ provenance: null }).unsourced, []);
});

test("health: unsourced counts toward the total, so it can actually fail a check", () => {
  assert.equal(healthTotal(provModel()), 2);
});
