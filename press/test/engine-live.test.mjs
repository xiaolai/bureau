// WI-L1 — live freshness on the board: the working-tree overlay + per-page badges + Drift section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { scan } from "../src/engine/scan.mjs";
import { readLog, appendEvent, logPath } from "../src/engine/log.mjs";
import { computeGate } from "../src/engine/gate.mjs";
import { liveFreshness } from "../src/engine/live.mjs";
import { buildSite } from "../src/build.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-live-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  const write = (rel, body) => writeFileSync(join(dir, rel), body);
  for (const [k, v] of Object.entries(files)) write(k, v);
  return { root, dir, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const UP = (def = "def") => `---\nid: U\ntitle: Upstream\n---\n# Upstream\n${def} ^u\n`;
const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\" }\n---\n# Downstream\nclaim ^d\n";
function confirmAll(dir) {
  const g = computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: dir }) }), events: readLog(logPath(dir)) });
  for (const e of g.edges) if (e.tracked && e.open && e.edgeId && e.verdictKey) appendEvent(logPath(dir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey });
}

test("live: a fully-scanned, confirmed corpus shows no badges and empty drift", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    const f = liveFreshness({ corpus: loadCorpus({ docsDir: w.dir }), docsDir: w.dir });
    assert.equal(f.byKey.size, 0);
    assert.equal(f.drift.length, 0);
    assert.deepEqual(f.counts, { needsReview: 0, stale: 0, modified: 0 });
  } finally { w.cleanup(); }
});

test("live: an UNCOMMITTED upstream edit shows dependent needs-review + upstream modified (before scan)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    // edit the working tree WITHOUT scanning — the live overlay should reflect it
    w.write("u.md", UP("def CHANGED"));
    const f = liveFreshness({ corpus: loadCorpus({ docsDir: w.dir }), docsDir: w.dir });
    assert.equal(f.byKey.get("Downstream"), "needs-review"); // rests on the changed span
    assert.equal(f.byKey.get("Upstream"), "modified");        // its own span edited, not yet recorded
    assert.equal(f.pending, 1);                               // one uncommitted span change
    assert.ok(f.drift.some((d) => d.page === "Downstream" && d.on === "Upstream"));
  } finally { w.cleanup(); }
});

test("live: removing a page file doesn't inflate the modified count (a deleted page has no badge)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    rmSync(join(w.dir, "u.md")); // delete the Upstream PAGE (its span lingers in the log as a pending delete)
    const f = liveFreshness({ corpus: loadCorpus({ docsDir: w.dir }), docsDir: w.dir });
    assert.equal(f.counts.modified, 0);               // the vanished page is not a "modified" live page
    assert.equal(f.byKey.get("Downstream"), "stale");  // D now rests on a missing target
    assert.ok(f.pending >= 1);                         // the delete is still reflected as an unscanned change
  } finally { w.cleanup(); }
});

test("live: a broken log degrades to no badges + surfaces the integrity failure", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const lf = logPath(w.dir);
    const lines = readFileSync(lf, "utf8").split("\n").filter(Boolean);
    const forged = JSON.parse(lines[0]); forged.hash = "TAMPERED"; lines[0] = JSON.stringify(forged);
    writeFileSync(lf, lines.join("\n") + "\n");
    const f = liveFreshness({ corpus: loadCorpus({ docsDir: w.dir }), docsDir: w.dir });
    assert.equal(f.byKey.size, 0);
    assert.ok(f.integrity && f.integrity.ok === false);
  } finally { w.cleanup(); }
});

test("live: buildSite injects the freshness badge into a page and a Drift section into Health", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN, "_config.json": '{"meta":{"title":"T","home":"Upstream"}}' });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    w.write("u.md", UP("def CHANGED")); // uncommitted edit → live drift
    const out = join(w.root, "dist");
    const r = buildSite({ root: w.root, docsDir: w.dir, outDir: out, force: true });
    assert.equal(r.freshness.needsReview, 1);
    const story = readFileSync(join(out, "lib", "content.js"), "utf8");
    assert.match(story, /"freshness":\s*"needs-review"/); // badge on the Downstream doc
    assert.match(story, /Drift · engine/);                // the live Health section
  } finally { w.cleanup(); }
});
