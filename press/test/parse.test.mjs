import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontmatter, parseHtmlDoc, extractLinks, relTargets } from "../src/core/parse.mjs";

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

// ── frontmatter: multi-line lists parse; the rest fails loud ──────────────────
// The regression: a multi-line YAML list used to (a) drop the list, and (b) harvest a bogus
// key from any item containing a colon — so `sources:` provenance vanished silently, and two
// colon-bearing items collided into a "duplicate key" crash. It is the idiom every author
// reaches for, so it now parses. What we can't represent still throws.
test("parse: a multi-line YAML list parses into an array (no longer dropped)", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\ntags:\n  - a\n  - b\n---\nbody");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
});

test("parse: a colon inside a list item is text, never a frontmatter key", () => {
  const doc = '---\ntitle: X\nsources:\n  - "theorist: Wayne"\n  - "theorist: Ada"\n---\nbody';
  const { frontmatter } = splitFrontmatter(doc);
  // used to throw `duplicate frontmatter key "- "theorist"` — a crash from reasonable data
  assert.deepEqual(frontmatter.sources, ["theorist: Wayne", "theorist: Ada"]);
  assert.deepEqual(Object.keys(frontmatter), ["title", "sources"]);
});

test("parse: multi-line list items keep their type — no YAML coercion", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\nvals:\n  - 2026-06-12\n  - no\n  - 3\n---\nb");
  // real YAML would hand back a Date, `false`, and a number. Strings only, by design.
  assert.deepEqual(frontmatter.vals, ["2026-06-12", "no", "3"]);
});

test("parse: a multi-line list of wiki-links becomes edge targets", () => {
  const { frontmatter } = splitFrontmatter('---\ntitle: X\nsources:\n  - "[[session a · 2026-06-10]]"\n  - "[[session b · 2026-06-11]]"\n---\nb');
  assert.deepEqual(relTargets(frontmatter.sources), ["session a · 2026-06-10", "session b · 2026-06-11"]);
});

test("parse: sequence items may sit at the key's own indent (valid YAML)", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\ntags:\n- a\n- b\n---\nb");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
});

test("parse: a nested map still throws rather than half-parsing", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\nmeta:\n  a: 1\n---\nb"), /unsupported frontmatter line/);
});

test("parse: a block scalar still throws rather than half-parsing", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\ndesc: |\n  line one\n---\nb"), /unsupported frontmatter line/);
});

test("parse: a stray list item under no key still throws", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\n- orphan\n---\nb"), /unsupported frontmatter line/);
});

test("parse: the error names the supported forms (actionable)", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\nmeta:\n  a: 1\n---\nb"), /multi-line[\s\S]*Nested maps, block scalars/);
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
