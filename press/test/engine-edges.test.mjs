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
