// Convergence telemetry (ADR-0001; roadmap §4.14) — the deterministic replay of the decision log.
// Asserts the honest signals: per-run work, repeated firings, queue depth/age, cutoff-beside-edges,
// and a stabilization verdict that tracks drain-vs-thrash. Drives the REAL flow (scan → gate →
// confirm) so the log it analyses is genuine, then projects the timeline from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { scan } from "../src/engine/scan.mjs";
import { readLog, appendEvent, logPath } from "../src/engine/log.mjs";
import { computeGate } from "../src/engine/gate.mjs";
import { projectTimeline, renderTimelineText } from "../src/engine/telemetry.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-telemetry-"));
  const dir = join(root, "canon");
  mkdirSync(dir, { recursive: true });
  const write = (rel, body) => writeFileSync(join(dir, rel), body);
  for (const [k, v] of Object.entries(files)) write(k, v);
  return { dir, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const modelOf = (dir) => buildModel({ corpus: loadCorpus({ docsDir: dir }) });
const gateOf = (dir) => computeGate({ model: modelOf(dir), events: readLog(logPath(dir)) });
const timelineOf = (dir) => projectTimeline({ model: modelOf(dir), events: readLog(logPath(dir)) });
// confirm every currently-open tracked edge — a review pass that drains the queue
function confirmAll(dir) {
  const g = gateOf(dir);
  for (const e of g.edges) if (e.tracked && e.open && e.edgeId) appendEvent(logPath(dir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey, by: "test" });
}
const UP = (def = "the definition") => "---\nid: U\ntitle: Upstream\n---\n# Upstream\n" + def + " ^u\n";
const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses the def\" }\n---\n# Downstream\nthe claim ^d\n";

test("telemetry: an empty log with no dependencies is drained (no history)", () => {
  const w = ws({ "u.md": UP(), "d.md": "---\nid: D\ntitle: Downstream\n---\n# Downstream\nno edges here ^d\n" });
  try {
    const t = timelineOf(w.dir); // no scan yet → no log; no rests_on → nothing dirty
    assert.equal(t.observations.length, 0);
    assert.equal(t.runs, 0);
    assert.equal(t.stabilization.verdict, "drained");
    assert.match(renderTimelineText(t), /no history yet/);
  } finally { w.cleanup(); }
});

test("telemetry: an empty log with a pending edge reflects the gate, not a false drained (fix #4)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN }); // D rests on U^u, but nothing has been scanned
  try {
    const t = timelineOf(w.dir);
    assert.equal(t.observations.length, 0);          // still no recorded history
    assert.equal(t.current.queueDepth, gateOf(w.dir).dirty.length); // but current mirrors the gate…
    assert.ok(t.current.queueDepth > 0);             // …which is dirty (the edge is unscanned/broken)
    assert.notEqual(t.stabilization.verdict, "drained"); // so telemetry must NOT claim drained
  } finally { w.cleanup(); }
});

test("telemetry: introduce → confirm → edit → confirm converges (fires twice, drains each time)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });                    // burst 1: introduce U^u, D^d
    confirmAll(w.dir);                            // review 1: cut off the edge → drain
    w.write("u.md", UP("the definition CHANGED")); // edit the cited upstream span
    scan({ docsDir: w.dir });                    // burst 2: edit U^u → D re-fires
    confirmAll(w.dir);                            // review 2: drain again

    const t = timelineOf(w.dir);
    assert.equal(t.runs, 2);                      // two edit-bursts
    assert.equal(t.reviews, 2);                   // two review drains
    assert.equal(t.repeatedFirings, 1);           // Downstream re-entered the queue
    assert.equal(t.maxFirings, 2);
    assert.equal(t.current.queueDepth, 0);        // queue drained
    assert.equal(t.stabilization.verdict, "drained");
    assert.equal(t.firings.find((f) => f.uid === "D").count, 2);
  } finally { w.cleanup(); }
});

test("telemetry: per-run work counts the structural events in each burst", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });                    // burst 1: 2 introduces
    confirmAll(w.dir);
    w.write("u.md", UP("changed once"));
    scan({ docsDir: w.dir });                    // burst 2: 1 edit
    const t = timelineOf(w.dir);
    assert.equal(t.perRunWork.max, 2);           // the seeding burst
    assert.equal(t.perRunWork.last, 1);          // the single-edit burst
  } finally { w.cleanup(); }
});

test("telemetry: a page that keeps re-firing is reported as thrashing (regardless of momentary depth)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);                 // fire 1 → drain
    w.write("u.md", UP("edit A")); scan({ docsDir: w.dir }); confirmAll(w.dir); // fire 2 → drain
    w.write("u.md", UP("edit B")); scan({ docsDir: w.dir });     // fire 3 (left outstanding)
    const t = timelineOf(w.dir);
    assert.ok(t.maxFirings >= 3, "Downstream fired at least three times");
    assert.equal(t.stabilization.verdict, "thrashing");
    assert.ok(t.queueAge.some((a) => a.uid === "D" && a.age >= 1)); // it is currently in the queue
  } finally { w.cleanup(); }
});

test("telemetry: a drain followed by one new edit is stabilizing, NOT thrashing (fix #2a)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);                 // fire once → drain (queue 1 → 0)
    w.write("u.md", UP("one new edit")); scan({ docsDir: w.dir }); // one new edit → queue 0 → 1
    const t = timelineOf(w.dir);
    // depth sequence dips to 0 then rises by one; the old code called that thrashing on the +1 delta
    assert.equal(t.stabilization.verdict, "stabilizing");
    assert.equal(t.stabilization.sustainedGrowth, false);
  } finally { w.cleanup(); }
});

test("telemetry: early churn that then settles decays out of the verdict (fix #2b)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN, "e.md": "---\nid: E\ntitle: Elsewhere\n---\n# Elsewhere\nv0 ^e\n" });
  try {
    // three quick fire→drain cycles on D (a churn burst): D re-enters the queue 3×
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    w.write("u.md", UP("a")); scan({ docsDir: w.dir }); confirmAll(w.dir);
    w.write("u.md", UP("b")); scan({ docsDir: w.dir }); confirmAll(w.dir);
    // then activity on an UNRELATED page (nothing rests on E, E rests on nothing) — advances the log
    // with a fresh observation that does NOT re-fire D, pushing the oldest fire out of the recent window
    w.write("e.md", "---\nid: E\ntitle: Elsewhere\n---\n# Elsewhere\nv1 ^e\n"); scan({ docsDir: w.dir });
    const t = timelineOf(w.dir);
    assert.ok(t.maxFirings >= 3, "the burst still shows in the lifetime stat");
    assert.ok(t.stabilization.recentMaxFirings < 3, "but recent churn has decayed");
    assert.notEqual(t.stabilization.verdict, "thrashing"); // lifetime churn alone no longer pins thrashing
  } finally { w.cleanup(); }
});

test("telemetry: one unconfirmed edge is stabilizing, not thrashing (a single point has no trend)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); // introduce only, never confirmed
    const t = timelineOf(w.dir);
    assert.equal(t.observations.length, 1);
    assert.equal(t.stabilization.queueGrowth, 0); // no trend from a single observation
    assert.equal(t.stabilization.verdict, "stabilizing");
  } finally { w.cleanup(); }
});

test("telemetry: the render reports the cutoff ratio BESIDE the edge count, never alone (§4.14)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    const out = renderTimelineText(timelineOf(w.dir));
    const cutoffLine = out.split("\n").find((l) => l.includes("cutoff ratio"));
    assert.ok(cutoffLine, "a cutoff-ratio line exists");
    assert.match(cutoffLine, /tracked edge/); // the ratio and the edge count share the line
  } finally { w.cleanup(); }
});

test("telemetry: renderTimelineText sanitizes control chars in a churning page's title (no terminal injection)", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    w.write("u.md", UP("changed")); scan({ docsDir: w.dir }); // D re-fires → it's a "churning page" name printed
    const evil = "Down" + String.fromCharCode(0x1b) + "[31m" + String.fromCharCode(0x0a) + "forged"; // ESC + newline in the title
    const out = renderTimelineText(timelineOf(w.dir), { titleOf: new Map([["D", evil]]) });
    // the whole title must land on ONE line — the injected newline was stripped, so it can't forge a
    // separate line — and that line carries no ESC/CR (which would inject ANSI). (\n between lines is fine.)
    const line = out.split("\n").find((l) => l.includes("Down"));
    assert.ok(line, "the churning page is printed");
    assert.match(line, /forged/); // 'forged' stayed on the same line: the title's newline did not split it
    assert.doesNotMatch(line, new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]")); // no control chars on the line
  } finally { w.cleanup(); }
});

test("telemetry: the projection is deterministic — identical input, byte-identical output", () => {
  const w = ws({ "u.md": UP(), "d.md": DOWN });
  try {
    scan({ docsDir: w.dir }); confirmAll(w.dir);
    w.write("u.md", UP("changed")); scan({ docsDir: w.dir });
    const a = JSON.stringify(timelineOf(w.dir));
    const b = JSON.stringify(timelineOf(w.dir));
    assert.equal(a, b);
  } finally { w.cleanup(); }
});
