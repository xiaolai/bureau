// WI-2 — object rests_on edges (ADR-0001, Decision B).
import { test } from "node:test";
import assert from "node:assert/strict";
import { restsOnEdges, parseInlineMap, parseMarkdownDoc } from "../src/core/parse.mjs";

test("restsOnEdges: object item → tracked edge with span + because", () => {
  const es = restsOnEdges([{ page: "[[Upstream]]", span: "^u", because: "uses the def" }]);
  assert.deepEqual(es, [{ target: "Upstream", edgeType: "rests_on", span: "^u", because: "uses the def", tracked: true }]);
});

test("restsOnEdges: bare string → UNTRACKED edge (no span, outside the sound-gate guarantee)", () => {
  const es = restsOnEdges(["[[Legacy]]"]);
  assert.deepEqual(es, [{ target: "Legacy", edgeType: "rests_on", span: null, because: null, tracked: false }]);
});

test("restsOnEdges: object with no page target is a loud error", () => {
  assert.throws(() => restsOnEdges([{ span: "^u" }]), /needs page/);
});

test("restsOnEdges: single-line inline-map string is parsed too", () => {
  const es = restsOnEdges('{ page: "[[T]]", span: "^s" }');
  assert.deepEqual(es, [{ target: "T", edgeType: "rests_on", span: "^s", because: null, tracked: true }]);
});

test("parseInlineMap: quoted commas/colons inside a value are literal", () => {
  const o = parseInlineMap('page: "[[T]]", because: "a, b: c"', "line");
  assert.equal(o.page, "[[T]]");
  assert.equal(o.because, "a, b: c");
});

test("parseMarkdownDoc: mixed rests_on list yields tracked + untracked edges, in order", () => {
  const md = [
    "---",
    "id: 01D",
    "title: Downstream",
    "trust: proposed",
    "rests_on:",
    '  - { page: "[[Upstream]]", span: "^u", because: "uses the def" }',
    '  - "[[Legacy]]"',
    "---",
    "# Downstream",
    "the claim ^d",
  ].join("\n");
  const p = parseMarkdownDoc(md);
  const ro = p.edges.filter((e) => e.edgeType === "rests_on");
  assert.equal(ro.length, 2);
  assert.deepEqual(ro[0], { target: "Upstream", edgeType: "rests_on", span: "^u", because: "uses the def", tracked: true });
  assert.equal(ro[1].target, "Legacy");
  assert.equal(ro[1].tracked, false);
  assert.deepEqual(p.spans.map((s) => s.anchor), ["d"]);
});

test("parseMarkdownDoc: two rests_on edges to different spans of one target both survive", () => {
  const md = [
    "---", "title: D", "rests_on:",
    '  - { page: "[[T]]", span: "^a" }',
    '  - { page: "[[T]]", span: "^b" }',
    "---", "# D", "x",
  ].join("\n");
  const ro = parseMarkdownDoc(md).edges.filter((e) => e.edgeType === "rests_on");
  assert.deepEqual(ro.map((e) => e.span).sort(), ["^a", "^b"]);
});

test("parse: a NON-flow nested map still throws (the grammar contract holds)", () => {
  const md = "---\ntitle: D\nbad:\n  nested: value\n---\n# D\nx";
  assert.throws(() => parseMarkdownDoc(md), /unsupported frontmatter line/);
});

// ── WI-1 (ADR layer): `supersedes` is a first-class plain typed edge ──────────────
// Characterization tests: `supersedes` is not FM_RESERVED, so it flows through the
// generic addRel like `contradicts` — no parser change. Lock that so later WIs can't
// regress it (e.g. by special-casing it into the rests_on span/because path).

test("parseMarkdownDoc: supersedes: [[X]] → one typed edge, lean {target,edgeType} shape", () => {
  const md = ["---", "title: ADR 0004", "supersedes: [[ADR 0003]]", "---", "# ADR 0004", "x"].join("\n");
  const es = parseMarkdownDoc(md).edges.filter((e) => e.edgeType === "supersedes");
  assert.equal(es.length, 1);
  // a generic typed edge (like contradicts) carries only {target, edgeType} at parse level —
  // span/because/tracked are added at the model layer (model.mjs), never here.
  assert.deepEqual(es[0], { target: "ADR 0003", edgeType: "supersedes" });
});

test("parseMarkdownDoc: supersedes coexists with rests_on + contradicts, none cross-contaminated", () => {
  const md = [
    "---", "title: D", "rests_on:",
    '  - { page: "[[U]]", span: "^u", because: "x" }',
    "contradicts: [[C]]", "supersedes: [[S]]", "---", "# D", "y ^u",
  ].join("\n");
  const es = parseMarkdownDoc(md).edges;
  const byType = (t) => es.filter((e) => e.edgeType === t);
  assert.equal(byType("supersedes").length, 1);
  assert.equal(byType("contradicts").length, 1);
  assert.equal(byType("rests_on").length, 1);
  // rests_on keeps its span/because/tracked; the generic edges do NOT carry those keys
  assert.deepEqual(byType("rests_on")[0], { target: "U", edgeType: "rests_on", span: "^u", because: "x", tracked: true });
  assert.deepEqual(byType("contradicts")[0], { target: "C", edgeType: "contradicts" });
  assert.deepEqual(byType("supersedes")[0], { target: "S", edgeType: "supersedes" });
});

test("parseMarkdownDoc: supersedes comma-list [[A]], [[B]] → two supersedes edges", () => {
  const md = ["---", "title: D", "supersedes: [[ADR 0001]], [[ADR 0002]]", "---", "# D", "z"].join("\n");
  const es = parseMarkdownDoc(md).edges.filter((e) => e.edgeType === "supersedes");
  assert.deepEqual(es.map((e) => e.target).sort(), ["ADR 0001", "ADR 0002"]);
});
