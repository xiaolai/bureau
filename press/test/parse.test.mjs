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

// ── frontmatter: fail loud, never silently mangle ─────────────────────────────
// The regression: a multi-line YAML list used to (a) drop the list, and (b) harvest a bogus
// key from any item containing a colon — so `sources:` provenance vanished silently, and two
// colon-bearing items collided into a "duplicate key" crash. Flat `key: value` is the contract.
test("parse: a multi-line YAML list throws instead of silently dropping the list", () => {
  const doc = '---\ntitle: X\nsources:\n  - "session abc (theorist: Wayne)"\n---\nbody';
  assert.throws(() => splitFrontmatter(doc), /unsupported frontmatter line/);
});

test("parse: the multi-line-list error names the supported forms (actionable)", () => {
  const doc = "---\ntitle: X\ntags:\n  - a\n  - b\n---\nbody";
  assert.throws(() => splitFrontmatter(doc), /key: \[a, b\][\s\S]*\*\*Sources\.\*\*/);
});

test("parse: a colon in a list item can no longer become a frontmatter key", () => {
  const doc = '---\ntitle: X\nsources:\n  - "theorist: Wayne"\n  - "theorist: Ada"\n---\nbody';
  // used to throw `duplicate frontmatter key "- "theorist"` — a crash from reasonable data
  assert.throws(() => splitFrontmatter(doc), /unsupported frontmatter line/);
});

test("parse: a nested map / block scalar throws rather than half-parsing", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\nmeta:\n  a: 1\n---\nb"), /unsupported frontmatter line/);
});

test("parse: the supported single-line forms still work", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\ntags: [a, b]\ncontradicts: [[Other]]\n---\nb");
  assert.equal(frontmatter.title, "X");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
  assert.equal(frontmatter.contradicts, "[[Other]]");
});

test("parse: blank lines and # comments in frontmatter are still ignored", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\n\n# a note: not a key\nstatus: proposed\n---\nb");
  assert.deepEqual(Object.keys(frontmatter), ["title", "status"]);
});
