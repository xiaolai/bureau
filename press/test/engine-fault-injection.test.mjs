// WI-7 - fault injection: mutate the graph/log, assert the gate responds (roadmap §4.15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { scan } from "../src/engine/scan.mjs";
import { readLog, appendEvent, logPath } from "../src/engine/log.mjs";
import { computeGate } from "../src/engine/gate.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-fault-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  const write = (rel, body) => writeFileSync(join(dir, rel), body);
  for (const [k, v] of Object.entries(files)) write(k, v);
  return { dir, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const gateOf = (dir) => { scan({ docsDir: dir }); return computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: dir }) }), events: readLog(logPath(dir)) }); };
const fresh = (g, uid) => g.freshness.get(uid);
const confirmAll = (dir, g) => { for (const e of g.edges) if (e.tracked && e.open && e.edgeId) appendEvent(logPath(dir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey, by: "t" }); };

const UP = (def = "the def") => `---\nid: U\ntitle: Upstream\n---\n# Upstream\n${def} ^u\n`;
const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses\" }\n---\n# Downstream\nthe claim ^d\n";

test("fault: mutating the upstream span content trips the gate for its dependent", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    assert.equal(fresh(gateOf(w.dir), "D"), "current");     // baseline confirmed
    w.write("u.md", UP("the def MUTATED"));                  // inject fault
    assert.equal(fresh(gateOf(w.dir), "D"), "needs-review"); // gate responds
  } finally { w.cleanup(); }
});

test("fault: deleting the upstream anchor makes the dependent stale (broken dep)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    w.write("u.md", "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe def with no anchor\n"); // remove ^u
    assert.equal(fresh(gateOf(w.dir), "D"), "stale");
  } finally { w.cleanup(); }
});

test("fault: retargeting the edge to a nonexistent page makes the dependent stale", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    confirmAll(w.dir, gateOf(w.dir));
    w.write("d.md", "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Ghost]]\", span: \"^x\" }\n---\n# Downstream\nthe claim ^d\n");
    assert.equal(fresh(gateOf(w.dir), "D"), "stale");
  } finally { w.cleanup(); }
});

test("fault: a stray confirm-edge for a wrong verdict key does NOT cut the edge off", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    // forge a confirmation with a bogus key: the gate compares keys, so this must not silence it
    const g0 = computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) });
    const eid = g0.edges.find((e) => e.tracked).edgeId;
    appendEvent(logPath(w.dir), { type: "confirm-edge", edge: eid, verdict_key: "WRONGKEY", by: "attacker" });
    assert.equal(fresh(gateOf(w.dir), "D"), "needs-review"); // still open - key mismatch
  } finally { w.cleanup(); }
});
