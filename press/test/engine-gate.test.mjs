// WI-5 - the deterministic gate: verdict-key cutoff, re-open on upstream change, cosmetic cutoff,
// untracked conservatism, cycle-safe blast radius (ADR-0001; roadmap §3-L1, §4.15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { scan } from "../src/engine/scan.mjs";
import { readLog, appendEvent, logPath } from "../src/engine/log.mjs";
import { computeGate, blastRadius } from "../src/engine/gate.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-gate-"));
  const dir = join(root, "canon");
  mkdirSync(dir, { recursive: true });
  const write = (rel, body) => writeFileSync(join(dir, rel), body);
  for (const [k, v] of Object.entries(files)) write(k, v);
  return { dir, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const gateOf = (dir) => { scan({ docsDir: dir }); return computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: dir }) }), events: readLog(logPath(dir)) }); };
const fresh = (g, uid) => g.freshness.get(uid);
// confirm every currently-open tracked edge (simulates a human review pass)
function confirmAll(dir, g) {
  for (const e of g.edges) if (e.tracked && e.open && e.edgeId) appendEvent(logPath(dir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey, by: "test" });
}

const UP = "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe definition ^u\n";
const DOWN = (extra = "") => "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses the def\" }\n---\n# Downstream\nthe claim ^d\n" + extra;

test("gate: an unconfirmed tracked edge makes the dependent needs-review", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN() });
  try {
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "needs-review");
    assert.equal(g.counts.open, 1);
  } finally { w.cleanup(); }
});

test("gate: confirming the edge cuts it off (dependent current); it is a real cutoff", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN() });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "current");
    assert.equal(g.counts.cutoff, 1);
    assert.equal(g.cutoffRatio, 1);
  } finally { w.cleanup(); }
});

test("gate: A->B->A on the upstream span re-opens the confirmed edge", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN() });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    w.write("u.md", "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe definition CHANGED ^u\n");
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "needs-review"); // upstream span revision bumped -> verdict key changed
  } finally { w.cleanup(); }
});

test("gate: an edit OUTSIDE the cited upstream span does NOT re-open (silent cutoff)", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN() });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    // add an unrelated paragraph to Upstream; the ^u block is untouched
    w.write("u.md", "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe definition ^u\n\nan unrelated aside\n");
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "current"); // propagates to nobody
  } finally { w.cleanup(); }
});

test("gate: editing the downstream claim span re-opens the edge (composite key)", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN() });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    w.write("d.md", "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses the def\" }\n---\n# Downstream\nthe claim REWORDED ^d\n");
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "needs-review"); // dep_span_revision changed -> verdict key changed
  } finally { w.cleanup(); }
});

test("gate: changing the `because` justification re-opens the edge", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN() });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    w.write("d.md", "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"a DIFFERENT reason\" }\n---\n# Downstream\nthe claim ^d\n");
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "needs-review");
  } finally { w.cleanup(); }
});

test("gate: an untracked (bare-string) rests_on is conservatively needs-review", () => {
  const w = ws({ "u.md": UP, "d.md": "---\nid: D\ntitle: Downstream\nrests_on: \"[[Upstream]]\"\n---\n# Downstream\nx ^d\n" });
  try {
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "needs-review");
    assert.equal(g.counts.untracked, 1);
    assert.equal(g.counts.tracked, 0); // excluded from the sound-gate accounting
  } finally { w.cleanup(); }
});

test("gate: a rests_on pointing at a missing span is stale (broken), not merely needs-review", () => {
  const w = ws({ "u.md": UP, "d.md": "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^ghost\" }\n---\n# Downstream\nx ^d\n" });
  try {
    const g = gateOf(w.dir);
    assert.equal(fresh(g, "D"), "stale");
    assert.equal(g.counts.broken, 1);
  } finally { w.cleanup(); }
});

test("blastRadius: terminates on a rests_on cycle, each node processed at most once", () => {
  const w = ws({
    "a.md": "---\nid: A\ntitle: Aye\nrests_on:\n  - { page: \"[[Bee]]\", span: \"^b\" }\n---\n# Aye\nx ^a\n",
    "b.md": "---\nid: B\ntitle: Bee\nrests_on:\n  - { page: \"[[Aye]]\", span: \"^a\" }\n---\n# Bee\nx ^b\n",
  });
  try {
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const br = blastRadius(model, "A");
    assert.deepEqual(br.affected, ["A", "B"]); // both reachable via the cycle
    assert.ok(br.processed <= 3); // bounded despite the cycle (no infinite walk)
  } finally { w.cleanup(); }
});
