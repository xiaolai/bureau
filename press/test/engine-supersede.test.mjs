// WI-2 (ADR layer) — projectSupersessions(): the effective-supersession decision core.
// PURE over hand-built { model, approvedSources:Set, eligibleTargets:Set }. Zero mocks.
// Effective iff source ∈ approvedSources (fresh-approved) AND target ∈ eligibleTargets (a real
// decision). Cycles detected over the fresh-approved edge graph only, fail-closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectSupersessions } from "../src/engine/supersede.mjs";

// hand-built model. nodeDefs: [key, uid, kind?]; edgeDefs: [sourceUid, targetKey]
function mk(nodeDefs, edgeDefs) {
  const nodes = {};
  for (const [key, uid, kind] of nodeDefs) nodes[key] = { id: key, uid, title: key, kind: kind || null };
  const edges = edgeDefs.map(([sourceUid, target]) => ({ source: null, sourceUid, target, edgeType: "supersedes" }));
  return { nodes, edges };
}
const entries = (m) => [...m].map(([k, v]) => [k, v]);

test("2.1 fresh-approved source + eligible target → supersededBy[N]=[M]", () => {
  const r = projectSupersessions({ model: mk([["M", "m"], ["N", "n"]], [["m", "N"]]), approvedSources: new Set(["m"]), eligibleTargets: new Set(["n"]) });
  assert.deepEqual(entries(r.supersededBy), [["n", ["m"]]]);
  assert.equal(r.cycles.length + r.broken.length + r.ineligible.length, 0);
});

test("2.2 source NOT in approvedSources → inert (core safety gate)", () => {
  const r = projectSupersessions({ model: mk([["M", "m"], ["N", "n"]], [["m", "N"]]), approvedSources: new Set(), eligibleTargets: new Set(["n"]) });
  assert.equal(r.supersededBy.size, 0);
  assert.equal(r.ineligible.length, 0); // source-gate fails before eligibility is even consulted
  assert.equal(r.cycles.length + r.broken.length, 0);
});

test("2.3 fresh-approved source, INELIGIBLE target → advisory, N untouched", () => {
  const r = projectSupersessions({ model: mk([["M", "m"], ["N", "n"]], [["m", "N"]]), approvedSources: new Set(["m"]), eligibleTargets: new Set() });
  assert.equal(r.supersededBy.size, 0);
  assert.deepEqual(r.ineligible, [{ sourceUid: "m", targetUid: "n" }]);
  assert.equal(r.cycles.length + r.broken.length, 0);
});

test("2.4 multiple approved supersessors of one target → sorted list", () => {
  const r = projectSupersessions({ model: mk([["M1", "m2"], ["M2", "m1"], ["N", "n"]], [["m2", "N"], ["m1", "N"]]), approvedSources: new Set(["m1", "m2"]), eligibleTargets: new Set(["n"]) });
  assert.deepEqual(r.supersededBy.get("n"), ["m1", "m2"]); // lexically sorted, not insertion order
});

test("2.5 broken supersedes (missing target node) → broken row, no effect", () => {
  const r = projectSupersessions({ model: mk([["M", "m"]], [["m", "Ghost"]]), approvedSources: new Set(["m"]), eligibleTargets: new Set(["m"]) });
  assert.deepEqual(r.broken, [{ sourceUid: "m", target: "Ghost" }]);
  assert.equal(r.supersededBy.size, 0);
});

test("2.6 approved A↔B cycle → both in cycles, neither superseded (fail-closed)", () => {
  const r = projectSupersessions({ model: mk([["A", "a"], ["B", "b"]], [["a", "B"], ["b", "A"]]), approvedSources: new Set(["a", "b"]), eligibleTargets: new Set(["a", "b"]) });
  assert.deepEqual(r.cycles.map((c) => [...c].sort()), [["a", "b"]]);
  assert.equal(r.supersededBy.size, 0);
});

test("2.7 self-supersede A→A → degenerate cycle, fail-closed", () => {
  const r = projectSupersessions({ model: mk([["A", "a"]], [["a", "A"]]), approvedSources: new Set(["a"]), eligibleTargets: new Set(["a"]) });
  assert.deepEqual(r.cycles, [["a"]]);
  assert.equal(r.supersededBy.size, 0);
});

test("2.8 mixed-approval cycle A↔B (only A fresh) → B superseded, NO cycle", () => {
  const r = projectSupersessions({ model: mk([["A", "a"], ["B", "b"]], [["a", "B"], ["b", "A"]]), approvedSources: new Set(["a"]), eligibleTargets: new Set(["a", "b"]) });
  assert.deepEqual(entries(r.supersededBy), [["b", ["a"]]]); // b→A is inert (b unapproved) → no cycle
  assert.equal(r.cycles.length, 0);
});

test("2.9 chain — unapproved middle link does not propagate", () => {
  const r = projectSupersessions({ model: mk([["M", "m"], ["N", "n"], ["O", "o"]], [["m", "N"], ["n", "O"]]), approvedSources: new Set(["m"]), eligibleTargets: new Set(["n", "o"]) });
  assert.deepEqual(entries(r.supersededBy), [["n", ["m"]]]);
  assert.ok(!r.supersededBy.has("o")); // N→O inert (N unapproved) → O not superseded
});

test("2.10 diamond — all fresh + eligible → both mid-targets superseded, no cycle", () => {
  const r = projectSupersessions({ model: mk([["M", "m"], ["N", "n"], ["P", "p"], ["O", "o"]], [["m", "N"], ["m", "P"], ["n", "O"], ["p", "O"]]), approvedSources: new Set(["m", "n", "p"]), eligibleTargets: new Set(["n", "p", "o"]) });
  assert.deepEqual(entries(r.supersededBy), [["n", ["m"]], ["o", ["n", "p"]], ["p", ["m"]]]);
  assert.equal(r.cycles.length, 0);
});

test("2.11 dedupe supersededBy via Set (duplicate M→N declared twice)", () => {
  const r = projectSupersessions({ model: mk([["M", "m"], ["N", "n"]], [["m", "N"], ["m", "N"]]), approvedSources: new Set(["m"]), eligibleTargets: new Set(["n"]) });
  assert.deepEqual(r.supersededBy.get("n"), ["m"]); // one entry, not ["m","m"]
});

const DIAMOND = () => ({ model: mk([["M", "m"], ["N", "n"], ["P", "p"], ["O", "o"]], [["m", "N"], ["m", "P"], ["n", "O"], ["p", "O"]]), approvedSources: new Set(["m", "n", "p"]), eligibleTargets: new Set(["n", "p", "o"]) });

test("2.12 determinism across repeated calls", () => {
  const norm = (r) => ({ supersededBy: entries(r.supersededBy), cycles: r.cycles, broken: r.broken, ineligible: r.ineligible });
  assert.deepEqual(norm(projectSupersessions(DIAMOND())), norm(projectSupersessions(DIAMOND())));
});

test("2.13 purity — no mutation of inputs", () => {
  const args = DIAMOND();
  const modelSnap = structuredClone(args.model);
  const apSnap = [...args.approvedSources], elSnap = [...args.eligibleTargets];
  projectSupersessions(args);
  assert.deepEqual(args.model, modelSnap);
  assert.deepEqual([...args.approvedSources], apSnap);
  assert.deepEqual([...args.eligibleTargets], elSnap);
});
