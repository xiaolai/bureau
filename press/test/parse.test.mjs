import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontmatter, parseHtmlDoc, parseMarkdownDoc, extractLinks, relTargets } from "../src/core/parse.mjs";

test("parse: BOM before --- does not defeat frontmatter (M15)", () => {
  const { frontmatter } = splitFrontmatter("\uFEFF---\ntitle: X\n---\nbody");
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
  assert.throws(() => splitFrontmatter("---\ntitle: X\nmeta:\n  a: 1\n---\nb"), /multi-line[\s\S]*must be QUOTED[\s\S]*not supported/);
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

// ── frontmatter: constructs we deliberately do NOT implement ─────────────────
test("parse: an UNQUOTED `- key: value` item is a YAML mapping and throws", () => {
  // the docs promise nested maps are rejected; silently reading this as the string
  // "theorist: Wayne" would be the same class of misread the parser exists to stop
  assert.throws(() => splitFrontmatter("---\ntitle: X\nsources:\n  - theorist: Wayne\n---\nb"), /unsupported frontmatter line/);
});

test("parse: a QUOTED item keeps its colon as text (real provenance strings work)", () => {
  const { frontmatter } = splitFrontmatter('---\ntitle: X\nsources:\n  - "session abc (theorist: Wayne)"\n---\nb');
  assert.deepEqual(frontmatter.sources, ["session abc (theorist: Wayne)"]);
});

test("parse: an unquoted URL item is not mistaken for a mapping", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\nrefs:\n  - https://example.com/a\n---\nb");
  assert.deepEqual(frontmatter.refs, ["https://example.com/a"]);
});

test("parse: an inline block-scalar marker throws (was silently the string '|')", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\ndesc: |\n---\nb"), /unsupported frontmatter line/);
  assert.throws(() => splitFrontmatter("---\ntitle: X\ndesc: >\n---\nb"), /unsupported frontmatter line/);
});

test("parse: a YAML anchor throws (was silently the string '&a X')", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: &a X\n---\nb"), /unsupported frontmatter line/);
});

// The guard must be TIGHT: rejecting anything that merely starts with | > & * - would throw on
// ordinary text. Anchors are rejected, so a `*alias` can never resolve — it is text, not YAML.
test("parse: ordinary values that LOOK yaml-ish are still plain text", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: *Hamlet*\nscore: -1\nnote: 3 > 2\n---\nb");
  assert.equal(frontmatter.title, "*Hamlet*");
  assert.equal(frontmatter.score, "-1");
  assert.equal(frontmatter.note, "3 > 2");
});

test("parse: list items that look yaml-ish are plain text, not nested sequences", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\nvals:\n  - -1\n  - --flag\n  - *emph*\n---\nb");
  assert.deepEqual(frontmatter.vals, ["-1", "--flag", "*emph*"]);
});

test("parse: an indented continuation under a list item throws (wrapped scalar)", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\ntags:\n  - a\n    continued\n---\nb"), /unsupported frontmatter line/);
});

test("parse: a nested sequence item throws", () => {
  assert.throws(() => splitFrontmatter("---\ntitle: X\ntags:\n  - - a\n---\nb"), /unsupported frontmatter line/);
});

test("parse: CRLF frontmatter with a multi-line list parses (Windows-authored docs)", () => {
  const { frontmatter } = splitFrontmatter('---\r\ntitle: X\r\nsources:\r\n  - "[[session a]]"\r\n  - "[[session b]]"\r\n---\r\nbody');
  assert.deepEqual(frontmatter.sources, ["[[session a]]", "[[session b]]"]);
  assert.deepEqual(relTargets(frontmatter.sources), ["session a", "session b"]);
});

test("parse: a bare `key:` with no items is an empty scalar, not a list", () => {
  const { frontmatter } = splitFrontmatter("---\ntitle: X\nsources:\n---\nb");
  assert.equal(frontmatter.sources, ""); // pinned: empty → no edge, no attribute
});

// ── body links: the model must not count what the renderer won't draw ────────
test("parse: a [[link]] inside a fenced code block is not a body link", () => {
  const d = parseMarkdownDoc("---\ntitle: X\n---\n\n# X\n\n```\n[[session a1b2 · 2026-06-10]]\n```\n");
  assert.deepEqual(d.bodyLinks, []);
});

test("parse: a [[link]] inside RAW HTML <pre>/<code> is not a body link either", () => {
  // markdown allows raw HTML; the renderer protects these regions, so counting them would
  // forge an edge the page never draws — and could forge provenance from inside a code sample
  const d = parseMarkdownDoc("---\ntitle: X\n---\n\n# X\n\n<pre>[[session a1b2 · 2026-06-10]]</pre>\n<code>[[session other]]</code>\n");
  assert.deepEqual(d.bodyLinks, []);
});

test("parse: a real [[link]] outside code is still counted", () => {
  const d = parseMarkdownDoc("---\ntitle: X\n---\n\n# X\n\n**Sources.** [[session a1b2 · 2026-06-10]]\n");
  assert.deepEqual(d.bodyLinks, ["session a1b2 · 2026-06-10"]);
});

test("parse: an <h1> inside raw HTML <pre> does not become the title", () => {
  const d = parseMarkdownDoc("<pre>\n# Fake Title\n</pre>\n\n# Real Title\n");
  assert.equal(d.meta.title, "Real Title");
});

// ── body links: the model must count only what the renderer draws ─────────────
test("parse (md): a [[link]] inside an HTML attribute is NOT a body link (phantom edge)", () => {
  // `<span title="[[X]]">` renders as an attribute, never a link — counting it would forge a
  // provenance/graph edge the page doesn't have. Only the real in-text link survives.
  const d = parseMarkdownDoc('---\ntitle: T\n---\n\n# T\n\n<span title="[[Fake]]">visible</span> and [[Real]]\n');
  assert.deepEqual(d.bodyLinks, ["Real"]);
});

test("parse (md): a [[link]] inside raw HTML <pre>/<code> is not a body link", () => {
  const d = parseMarkdownDoc("---\ntitle: T\n---\n\n# T\n\n<pre>[[InPre]]</pre> <code>[[InCode]]</code> [[Real]]\n");
  assert.deepEqual(d.bodyLinks, ["Real"]);
});

test("parse (html): an entity-encoded [[A&amp;B]] in text resolves to the real title A&B", () => {
  const d = parseHtmlDoc('<article data-group="g"><h1>T</h1><p>see [[A&amp;B]]</p></article>');
  assert.deepEqual(d.bodyLinks, ["A&B"]);
});

test("parse: a frontmatter multi-line sources list of wiki-links yields edge targets", () => {
  const d = parseMarkdownDoc('---\ntitle: T\nsources:\n  - "[[session a · 2026-06-10]]"\n  - "[[session b · 2026-06-11]]"\n---\n\n# T\n');
  const srcEdges = d.edges.filter((e) => e.edgeType === "sources").map((e) => e.target).sort();
  assert.deepEqual(srcEdges, ["session a · 2026-06-10", "session b · 2026-06-11"]);
});
