// WI-7 - the load-bearing engine properties (roadmap §4.15), stated as invariants over generated
// graphs. The vacuous "affected ⊆ reachable" is deliberately NOT here (§4.15 drops it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { scan } from "../src/engine/scan.mjs";
import { readLog, appendEvent, logPath } from "../src/engine/log.mjs";
import { computeGate, blastRadius } from "../src/engine/gate.mjs";
import { buildDerived, derivedDigest } from "../src/engine/fsck.mjs";

function ws() {
  const root = mkdtempSync(join(tmpdir(), "wb-prop-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  return { dir, write: (rel, body) => writeFileSync(join(dir, rel), body), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Property: the derived tier is a PURE function of (corpus + log) - N rebuilds, identical bytes.
test("property: buildDerived is deterministic across repeated builds", () => {
  const w = ws();
  try {
    w.write("u.md", "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n");
    w.write("d.md", "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\", because: \"b\" }\n---\n# Down\nclaim ^d\n");
    scan({ docsDir: w.dir });
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const events = readLog(logPath(w.dir));
    const digests = new Set();
    for (let i = 0; i < 5; i++) digests.add(derivedDigest(buildDerived({ model, events })));
    assert.equal(digests.size, 1);
  } finally { w.cleanup(); }
});

// Property: on a chain WITH a back-edge (cycle), the blast-radius walk visits each affected node at
// most once and terminates - the (node, revision) visited-token guarantee (§2.4).
test("property: blastRadius processes each node at most once, even with a cycle", () => {
  const w = ws();
  try {
    const N = 12;
    // chain n_i rests_on n_{i-1}; plus a back-edge n_0 rests_on n_{N-1} to force a cycle
    for (let i = 0; i < N; i++) {
      const deps = [];
      if (i > 0) deps.push(`  - { page: "[[N${i - 1}]]", span: "^s${i - 1}" }`);
      if (i === 0) deps.push(`  - { page: "[[N${N - 1}]]", span: "^s${N - 1}" }`);
      w.write(`n${i}.md`, `---\nid: N${i}\ntitle: N${i}\nrests_on:\n${deps.join("\n")}\n---\n# N${i}\nclaim ^s${i}\n`);
    }
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const br = blastRadius(model, "N0");
    assert.equal(new Set(br.affected).size, br.affected.length); // no node listed twice
    assert.ok(br.affected.length <= N);
    assert.ok(br.processed <= N + 1); // bounded: root + at-most-once per node
  } finally { w.cleanup(); }
});

// Property: independent edits grow the affected set but each still re-opens exactly its own
// dependent - convergence is "bounded per-run work", not monotonic shrinkage (§0.5).
test("property: two independent upstream edits dirty exactly their two dependents", () => {
  const w = ws();
  try {
    w.write("u1.md", "---\nid: U1\ntitle: Up1\n---\n# Up1\ndef ^a\n");
    w.write("u2.md", "---\nid: U2\ntitle: Up2\n---\n# Up2\ndef ^b\n");
    w.write("d1.md", "---\nid: D1\ntitle: Down1\nrests_on:\n  - { page: \"[[Up1]]\", span: \"^a\" }\n---\n# Down1\nc ^d1\n");
    w.write("d2.md", "---\nid: D2\ntitle: Down2\nrests_on:\n  - { page: \"[[Up2]]\", span: \"^b\" }\n---\n# Down2\nc ^d2\n");
    scan({ docsDir: w.dir });
    let g = computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) });
    for (const e of g.edges) if (e.tracked && e.open) appendEvent(logPath(w.dir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey, by: "t" });
    // edit both upstreams independently
    w.write("u1.md", "---\nid: U1\ntitle: Up1\n---\n# Up1\ndef CHANGED ^a\n");
    w.write("u2.md", "---\nid: U2\ntitle: Up2\n---\n# Up2\ndef CHANGED ^b\n");
    scan({ docsDir: w.dir });
    g = computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) });
    const dirty = g.dirty.map((d) => d.uid).sort();
    assert.deepEqual(dirty, ["D1", "D2"]); // each edit hit exactly its own dependent
  } finally { w.cleanup(); }
});
