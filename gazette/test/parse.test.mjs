import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontmatter, parseHtmlDoc, extractLinks } from "../src/core/parse.mjs";

test("parse: BOM before --- does not defeat frontmatter (M15)", () => {
  const { frontmatter } = splitFrontmatter("﻿---\ntitle: X\n---\nbody");
  assert.ok(frontmatter);
  assert.equal(frontmatter.title, "X");
});

test("parse: duplicate frontmatter key throws (M15)", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: A\ntitle: B\n---\nx"), /duplicate frontmatter key/);
});

test("parse: typed [[link]] stays raw; inline [a,b] becomes a list", () => {
  const { frontmatter } = splitFrontmatter("---\ncontradicts: [[X]]\ntags: [a, b]\n---\nx");
  assert.equal(frontmatter.contradicts, "[[X]]");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
});

test("parse: links inside <pre>/<code> are NOT extracted as edges (H4)", () => {
  const html = '<article data-group="g"><h1>T</h1>' +
    "<p>see [[Real]]</p><pre>[[InCode]]</pre><p>and <code>[[InlineCode]]</code> too</p></article>";
  assert.deepEqual(parseHtmlDoc(html).bodyLinks, ["Real"]);
});

test("parse: empty/whitespace [[ ]] targets are dropped (L5)", () => {
  assert.deepEqual(extractLinks("a [[]] b [[ ]] c [[Real]]"), ["Real"]);
});
