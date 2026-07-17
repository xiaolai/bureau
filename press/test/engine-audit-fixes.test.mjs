// Regression tests for the round-1 Codex audit fixes on the recursion engine. Each test names the
// finding it locks down so a future change can't quietly reintroduce it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSpans, restsOnEdges, parseInlineMap, parseMarkdownDoc, parseHtmlDoc } from "../src/core/parse.mjs";
import { appendEvent as appendEv } from "../src/engine/log.mjs";
import { projectRevisions, spanRevision } from "../src/engine/revisions.mjs";
import { appendEvent, logPath } from "../src/engine/log.mjs";
import { recordVerification, readVerify } from "../src/engine/ledgers.mjs";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { scan } from "../src/engine/scan.mjs";
import { computeGate } from "../src/engine/gate.mjs";
import { mutationGate } from "../src/engine/mutation.mjs";
import { fsck } from "../src/engine/fsck.mjs";
import { readLog } from "../src/engine/log.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-fix-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// #20 — extractSpans must not see anchors inside code fences or on heading lines.
test("fix #20: extractSpans masks code fences and heading lines (no phantom spans)", () => {
  const body = "# Heading ^h\n\nreal claim ^c\n\n```\ncode ^inside\n```\n";
  assert.deepEqual(extractSpans(body).map((s) => s.anchor), ["c"]);
});

// #21 — in-span whitespace is content; changing it must change the span text (and thus its hash).
test("fix #21: extractSpans preserves in-span whitespace (no lossy trim)", () => {
  const a = extractSpans("  indented claim ^c")[0].text;
  const b = extractSpans("claim ^c")[0].text;
  assert.notEqual(a, b);          // indentation is preserved, so the two differ
  assert.match(a, /^ {2}indented/); // leading spaces kept
});

// #23 — a rests_on OBJECT edge must carry a span; a spanless object is a loud error, not untracked.
test("fix #23: object rests_on without a span throws (only bare strings are untracked)", () => {
  assert.throws(() => restsOnEdges([{ page: "[[T]]" }]), /needs a span/);
  assert.deepEqual(restsOnEdges(["[[T]]"]), [{ target: "T", edgeType: "rests_on", span: null, because: null, tracked: false }]);
});

// #22 — parseInlineMap enforces the loud-error contract.
test("fix #22: parseInlineMap rejects unknown keys, duplicate keys, and unbalanced quotes", () => {
  assert.throws(() => parseInlineMap('page: "[[T]]", bogus: 1', "l"), /unsupported key/);
  assert.throws(() => parseInlineMap('page: "[[T]]", page: "[[U]]"', "l"), /duplicate key/);
  assert.throws(() => parseInlineMap('page: "[[T]]', "l"), /unbalanced quote/);
});

// #19 — the bounded {..} map is accepted ONLY under rests_on, never for another list key.
test("fix #19: an inline {..} map under a non-rests_on key still throws", () => {
  assert.throws(() => parseMarkdownDoc("---\ntitle: D\ntags:\n  - { a: b }\n---\n# D\nx"), /unsupported frontmatter/);
});

// #3 — revision is the COUNT of introduce|edit events; a second introduce increments (never resets).
test("fix #3: a duplicate introduce increments the revision (count semantics, no reset)", () => {
  const events = [
    { seq: 1, type: "introduce", id: "P", span: "^c", hash: "H1" },
    { seq: 2, type: "edit", id: "P", span: "^c", hash: "H2" },
    { seq: 3, type: "introduce", id: "P", span: "^c", hash: "H3" }, // stray re-introduce
  ];
  assert.equal(spanRevision(projectRevisions(events), "P", "^c"), 3);
});

// #2 — the log rejects a malformed event (an introduce with no hash) before it lands.
test("fix #2: appendEvent rejects a malformed event (introduce missing hash)", () => {
  const lf = logPath(mkdtempSync(join(tmpdir(), "wb-fixlog-")));
  assert.throws(() => appendEvent(lf, { type: "introduce", id: "P", span: "^c" }), /malformed introduce/);
  assert.throws(() => appendEvent(lf, { type: "confirm-edge", edge: "e" }), /malformed confirm-edge/); // no verdict_key
});

// #11 — a page literally named "__proto__" must not pollute Object.prototype.
test("fix #11: a page named __proto__ is stored as data, not a prototype mutation", () => {
  const r = mkdtempSync(join(tmpdir(), "wb-proto-"));
  writeFileSync(join(r, "a.txt"), "x");
  recordVerification(r, { root: r, page: "__proto__", artifact: "a.txt", claim: "c", date: "2026-07-17" });
  assert.equal(({}).checks, undefined);                 // Object.prototype untouched
  assert.ok(readVerify(r)["__proto__"]);                // stored as an own key
  rmSync(r, { recursive: true, force: true });
});

// #7 — a tracked edge whose dependent anchors NO claim span can't cut off (conservatively dirty).
test("fix #7: a dependent with no claim span is needs-review, never silently cut off", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\" }\n---\n# Down\nno anchor here\n",
  });
  try {
    scan({ docsDir: w.dir });
    const g = computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) });
    assert.equal(g.freshness.get("D"), "needs-review");
    assert.ok(g.edges.some((e) => e.reason === "downstream-unanchored"));
  } finally { w.cleanup(); }
});

// #16 — a page with one BROKEN edge must not exclude its OTHER, valid edge from mutation testing.
test("fix #16: mutation isolates per-edge — a broken sibling edge doesn't mask a real kill", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
    // one page, two edges: one valid (^u), one broken (^ghost). The valid edge must still be killed.
    "d.md": "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\" }\n  - { page: \"[[Up]]\", span: \"^ghost\" }\n---\n# Down\nclaim ^d\n",
  });
  try {
    const r = mutationGate({ docsDir: w.dir });
    assert.equal(r.gateable, 1);   // the ^u edge is gateable despite the broken sibling
    assert.equal(r.killed, 1);
    assert.ok(r.survivors.some((s) => s.reason === "target-span-missing")); // the ^ghost edge
  } finally { w.cleanup(); }
});

// #7 (round 2) — a multi-claim dependent: editing a NON-first claim still reopens the edge.
test("fix #7b: editing a non-first claim on a multi-span dependent reopens the edge", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\" }\n---\n# Down\nfirst claim ^d1\n\nsecond claim ^d2\n",
  });
  try {
    scan({ docsDir: w.dir });
    let g = computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) });
    for (const e of g.edges) if (e.tracked && e.open) appendEv(logPath(w.dir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey });
    assert.equal(computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) }).freshness.get("D"), "current");
    // edit the SECOND claim only (the first-span heuristic would miss this; the sum-of-revisions does not)
    writeFileSync(join(w.dir, "d.md"), "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\" }\n---\n# Down\nfirst claim ^d1\n\nsecond claim REWORDED ^d2\n");
    scan({ docsDir: w.dir });
    assert.equal(computeGate({ model: buildModel({ corpus: loadCorpus({ docsDir: w.dir }) }), events: readLog(logPath(w.dir)) }).freshness.get("D"), "needs-review");
  } finally { w.cleanup(); }
});

// #24 — HTML data-rests_on is normalized to an untracked edge, not a bare generic edge.
test("fix #24: HTML data-rests_on becomes a normalized untracked rests_on edge", () => {
  const p = parseHtmlDoc('<article data-rests_on="[[X]]"><h1>D</h1></article>');
  const ro = p.edges.filter((e) => e.edgeType === "rests_on");
  assert.deepEqual(ro, [{ target: "X", edgeType: "rests_on", span: null, because: null, tracked: false }]);
});

// #20 (round 2) — masking also covers <script>/<style> and Setext headings.
test("fix #20b: extractSpans masks script/style blocks and Setext headings", () => {
  assert.deepEqual(extractSpans("<script>\nvar x ^s\n</script>\n\nreal ^r").map((s) => s.anchor), ["r"]);
  assert.deepEqual(extractSpans("Heading claim ^h\n===\n\nbody ^b").map((s) => s.anchor), ["b"]); // ^h is a Setext heading
});

// #22 (round 2) — an embedded/stray quote in an inline-map value is rejected.
test("fix #22b: a stray quote inside an inline-map value is a loud error", () => {
  assert.throws(() => parseInlineMap('page: [[T]]"oops', "l"), /stray quote/);
});

// #4 — the decided-state projection (state.mjs) is actually wired into the derived tier.
test("fix #4: buildDerived surfaces decided state; approval backs canonical", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: Pee\ntrust: canonical\n---\n# Pee\nx ^p\n" });
  try {
    scan({ docsDir: w.dir });
    const before = fsck({ docsDir: w.dir, write: false }).derived.decided.find((d) => d.uid === "P");
    assert.equal(before.trust, "canonical");
    assert.equal(before.trustBacked, false); // authored, no approve event yet
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "u" });
    const after = fsck({ docsDir: w.dir, write: false }).derived.decided.find((d) => d.uid === "P");
    assert.equal(after.trustBacked, true);
  } finally { w.cleanup(); }
});
