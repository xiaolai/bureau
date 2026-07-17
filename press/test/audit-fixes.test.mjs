// Regression tests for the audit-fix #2 round (markdown/Obsidian lane + serve + CLI).
// Each test pins one finding from the Codex audit so the fix can't silently regress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractBodyLinks, replaceOutsideRaw, addHeadingIds, markdownToHtml,
  parseMarkdownDoc, parseHtmlDoc, rewriteWikiRef, resolveImageEmbeds,
} from "../src/core/parse.mjs";
import { slugify } from "../src/shared/slug.mjs";
import { makeResolve } from "../src/runtime/pure.mjs";
import { buildSite } from "../src/build.mjs";

// `t` (the test context) registers cleanup so the temp corpus doesn't leak filesystem state.
const tmp = (t) => {
  const d = mkdtempSync(join(tmpdir(), "wb-auditfix-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

// ── parse.mjs:130/250 — body-link extraction normalizes anchors + drops image embeds ──
test("extractBodyLinks: [[Doc#Heading]] yields target Doc (anchor stripped)", () => {
  assert.deepEqual(extractBodyLinks("see [[Lin#Backstory]] now"), ["Lin"]);
});
test("extractBodyLinks: [[#local]] (same-doc anchor) is not a document link", () => {
  assert.deepEqual(extractBodyLinks("jump to [[#Background]]"), []);
});
test("extractBodyLinks: ![[pic.png]] image embed is not a document link", () => {
  assert.deepEqual(extractBodyLinks("![[diagram.png]] and [[Wei]]"), ["Wei"]);
});
test("extractBodyLinks: ![[Note]] note transclusion still counts as a doc edge", () => {
  assert.deepEqual(extractBodyLinks("![[Other Note]]"), ["Other Note"]);
});
test("parseMarkdownDoc.bodyLinks: anchors stripped, embeds excluded, code ignored", () => {
  const d = parseMarkdownDoc("---\ntitle: A\n---\n[[B#h]] ![[c.png]] `[[InCode]]` [[D]]\n");
  assert.deepEqual(d.bodyLinks.sort(), ["B", "D"]);
});
test("parseHtmlDoc.bodyLinks: data-wiki anchor stripped, code-fenced link ignored", () => {
  const d = parseHtmlDoc('<article data-title="A"><p>[[B#sec]]</p><pre>[[InPre]]</pre></article>');
  assert.deepEqual(d.bodyLinks, ["B"]);
});

// ── parse.mjs:61 — replaceOutsideRaw masks <pre>/<code>/comments ──
test("replaceOutsideRaw: transform fires outside code, not inside <code>", () => {
  const out = replaceOutsideRaw("x <code>x</code> x", (h) => h.replace(/x/g, "Y"));
  assert.equal(out, "Y <code>x</code> Y");
});

// ── parse.mjs:187 — callouts survive a nested blockquote ──
test("renderCallouts: a nested blockquote inside a callout is not truncated", () => {
  const h = markdownToHtml("> [!note] Title\n> outer\n>\n> > nested quote\n");
  assert.match(h, /callout callout-note/);
  assert.match(h, /nested quote/);
  // the callout wrapper must contain the nested blockquote, not stop before it
  assert.match(h, /callout-body[\s\S]*nested quote[\s\S]*<\/div><\/div>/);
});

// ── parse.mjs:204 — addHeadingIds reserves author-supplied ids ──
test("addHeadingIds: a generated id never duplicates an existing author id", () => {
  const out = addHeadingIds('<h2 id="intro">x</h2><h2>Intro</h2>');
  const ids = [...out.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length); // all unique
  assert.ok(ids.includes("intro") && ids.includes("intro-2"));
});

// ── parse.mjs:267 — decodeEntities does not crash on out-of-range numeric entities ──
test("rewriteWikiRef: an out-of-range &#x110000; entity does not throw", () => {
  assert.doesNotThrow(() => rewriteWikiRef('<p data-wiki="&#x110000;">x</p> [[A]]', "A", "B"));
});

// ── parse.mjs:314 — rewriteWikiRef preserves an #anchor when renaming the target ──
test("rewriteWikiRef: [[Old#H]] → [[New#H]] (anchor preserved)", () => {
  const { html, count } = rewriteWikiRef("<p>[[Old#Heading]] [[Old|label]]</p>", "Old", "New");
  assert.match(html, /\[\[New#Heading\]\]/);
  assert.match(html, /\[\[New\|label\]\]/);
  assert.equal(count, 2);
});
// ── parse.mjs:319 — rewriteWikiRef matches an entity-encoded data-wiki ──
test("rewriteWikiRef: data-wiki=\"A&amp;B\" renamed when from is A&B", () => {
  const { html, count } = rewriteWikiRef('<a data-wiki="A&amp;B">x</a>', "A&B", "C");
  assert.match(html, /data-wiki="C"/);
  assert.equal(count, 1);
});

// ── shared/slug.mjs:5 — NFC so composed/decomposed headings share one anchor ──
test("slugify: NFC-equal strings (composed vs decomposed) slug identically", () => {
  assert.equal(slugify("café".normalize("NFC")), slugify("café".normalize("NFD")));
});

// ── build.mjs:181 — guardOutDir rejects --out overlapping the content dir ──
test("buildSite: --out inside the content dir is refused", (t) => {
  const root = tmp(t);
  const docs = join(root, "gazette");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "a.html"), '<article data-title="A"><p>x</p></article>');
  assert.throws(
    () => buildSite({ root, docsDir: docs, outDir: join(docs, "dist") }),
    /overlaps the content dir/,
  );
});

test("buildSite: --out at the filesystem root / is refused (ancestor guard)", (t) => {
  const root = tmp(t);
  const docs = join(root, "gazette");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "a.html"), '<article data-title="A"><p>x</p></article>');
  assert.throws(
    () => buildSite({ root, docsDir: docs, outDir: "/" }),
    /project root or an ancestor/,
  );
});

// ── sources.mjs:17 — discovery skips symlinked files (no external reads) ──
test("buildSite: a symlinked doc inside the content dir is not discovered", (t) => {
  const root = tmp(t);
  const docs = join(root, "gazette");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "real.html"), '<article data-title="Real"><p>hi</p></article>');
  const outside = join(root, "secret.html");
  writeFileSync(outside, '<article data-title="Secret"><p>leak</p></article>');
  // don't let a symlink-creation failure masquerade as a pass — that would silently drop the
  // security coverage. Skip explicitly (proving symlinks are unavailable) instead of returning green.
  try { symlinkSync(outside, join(docs, "link.html")); }
  catch (e) { t.skip("symlinks unsupported on this filesystem: " + e.message); return; }
  const r = buildSite({ root, docsDir: docs, outDir: join(root, "dist") });
  assert.equal(r.totalDocs != null, true);
  // the symlinked doc must not appear in the model
  const corpusTitles = JSON.stringify(r);
  assert.ok(!corpusTitles.includes("Secret"));
});

// ── build.mjs:114 — embed markers inside <pre>/<code> stay literal ──
test("buildSite: ![[Note]] inside a code block is not transcluded", (t) => {
  const root = tmp(t);
  const docs = join(root, "gazette");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "note.html"), '<article data-title="Note"><p>secret body</p></article>');
  writeFileSync(join(docs, "host.md"), "---\ntitle: Host\n---\n```\n![[Note]]\n```\n");
  buildSite({ root, docsDir: docs, outDir: join(root, "dist") });
  // read the artifact DIRECTLY — a missing/unreadable output must fail the test loudly, not be
  // swallowed into an empty string that then produces a misleading assertion failure.
  const out = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  assert.ok(out.includes("![[Note]]"));      // literal marker survives in the code block
  // the only wb-embed in the output (if any) must not come from the fenced Host doc —
  // assert the code block stayed a <pre><code> with the literal marker, untranscluded
  assert.match(out, /<pre><code>!\[\[Note\]\]/);
});

// ════════ Round 3 (deeper audit) regressions ════════

// ── model.mjs — a doc titled __proto__ is rejected loudly (can't be a literal key) ──
test("buildSite: a doc titled __proto__ is rejected, and Object.prototype is untouched", (t) => {
  const root = tmp(t);
  const docs = join(root, "gazette");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "a.html"), '<article data-title="__proto__"><p>x [[Real]]</p></article>');
  writeFileSync(join(docs, "b.html"), '<article data-title="Real"><p>y</p></article>');
  assert.throws(
    () => buildSite({ root, docsDir: docs, outDir: join(root, "dist") }),
    /invalid title "__proto__"/,
  );
  assert.equal(({}).group, undefined); // no prototype pollution occurred
});

// ── runtime — a route like #/constructor resolves as MISSING (own-property lookup) ──
test("makeResolve: target 'constructor' resolves as missing (no inherited-prop match)", () => {
  const html = makeResolve({ Real: {} }, null)("constructor", "constructor");
  assert.match(html, /wikilink--missing/);
  assert.ok(!/href=/.test(html));
});

// ── build.mjs guardOutDir — the .tmp/.bak siblings are guarded too ──
test("buildSite: --out whose .tmp sibling is the content dir is refused", (t) => {
  const root = tmp(t);
  const docs = join(root, "dist.tmp"); // == outDir + ".tmp" when outDir=<root>/dist
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "a.html"), '<article data-title="A"><p>x</p></article>');
  assert.throws(
    () => buildSite({ root, docsDir: docs, outDir: join(root, "dist") }),
    /overlaps the content dir/,
  );
});

// ── parse.mjs renderCallouts — title is single-escaped, not double-escaped ──
test("callout: > [!note] A & B renders the title as 'A & B' (single-escaped)", () => {
  const h = markdownToHtml("> [!note] A & B\n> body\n");
  assert.match(h, /callout-title">A &amp; B</);
  assert.ok(!h.includes("A &amp;amp; B"));
});

// ── parse.mjs addHeadingIds — heading id matches the wiki-anchor slug (entity decode) ──
test("addHeadingIds: '## A & B' gets id matching makeResolve's [[Doc#A & B]] anchor", () => {
  const id = addHeadingIds(markdownToHtml("## A & B")).match(/id="([^"]+)"/)[1];
  assert.equal(id, slugify("A & B"));
  const anchorHref = makeResolve({ Doc: {} }, "Doc")("Doc#A & B", "Doc#A & B").match(/h=([^"&]+)/);
  assert.equal(decodeURIComponent(anchorHref[1]), id);
});

// ── parse.mjs isInRawText — a <code data-wiki> element is not counted as a body link ──
test("parseHtmlDoc.bodyLinks: <code data-wiki=\"Wei\"> is not a body link", () => {
  const d = parseHtmlDoc('<article data-title="A"><code data-wiki="Wei">x</code> [[Real]]</article>');
  assert.deepEqual(d.bodyLinks, ["Real"]);
});

// ── parse.mjs rewriteRelValue — anchored relation refs keep their #anchor on rename ──
test("rewriteWikiRef: data-rel=\"[[Old#H]]\" → [[New#H]] (anchor preserved)", () => {
  const { html, count } = rewriteWikiRef('<article data-rel="[[Old#H]]"><p>x</p></article>', "Old", "New");
  assert.match(html, /\[\[New#H\]\]/);
  assert.equal(count, 1);
});

// ── parse.mjs resolveImageEmbeds — a marker inside an attribute value is not rewritten ──
test("resolveImageEmbeds: ![[x.png]] inside an attribute value is left untouched", () => {
  const out = resolveImageEmbeds('<img alt="![[x.png]]">', { "x.png": "assets/x.png" });
  assert.equal(out, '<img alt="![[x.png]]">');
});

// ════════ Round 4 (deep audit) regressions ════════

// ── slug.mjs — no tag-stripping, so 'A < B' and 'A B' (→ 'A C') don't collide ──
test("slugify: 'A < B > C' is not tag-stripped into 'a-c'", () => {
  assert.equal(slugify("A < B > C"), "a-b-c");
  assert.notEqual(slugify("A < B > C"), slugify("A C"));
});
test("addHeadingIds: a heading with an inline <em> still slugs to plain text", () => {
  const id = addHeadingIds("<h2>A <em>B</em></h2>").match(/id="([^"]+)"/)[1];
  assert.equal(id, "a-b");
});
test("addHeadingIds + makeResolve agree on a heading containing '<'", () => {
  const id = addHeadingIds(markdownToHtml("## A < B")).match(/id="([^"]+)"/)[1];
  const href = makeResolve({ Doc: {} }, "Doc")("Doc#A < B", "x").match(/h=([^"&]+)/);
  assert.equal(decodeURIComponent(href[1]), id);
});

// ── parse.mjs addHeadingIds — a literal id="x" inside a code block isn't reserved ──
test("addHeadingIds: id shown inside <pre><code> does not steal the heading's natural id", () => {
  const out = addHeadingIds('<pre><code>&lt;p id="intro"&gt;</code></pre><h2>Intro</h2>');
  assert.match(out, /<h2 id="intro">Intro<\/h2>/); // not intro-2
});

// ── parse.mjs rewriteWikiRef — typed-relation entity-encoded targets are renamed ──
test("rewriteWikiRef: data-rel=\"[[A&amp;B]]\" renamed when from is A&B", () => {
  const { html, count } = rewriteWikiRef('<article data-rel="[[A&amp;B]]"><p>x</p></article>', "A&B", "C");
  assert.match(html, /\[\[C\]\]/);
  assert.equal(count, 1);
});

// ── parse.mjs stripMdCode — fence-complete: feeds title fallback + bodyLinks ──
test("parseMarkdownDoc: a heading inside a closed code fence is not the title fallback", () => {
  const d = parseMarkdownDoc("---\nx: 1\n---\n```\n# Fake\n[[InCode]]\n```\n# Real\n\n[[Link]]\n");
  assert.equal(d.meta.title, "Real");
  assert.deepEqual(d.bodyLinks, ["Link"]);
});
test("parseMarkdownDoc: an unclosed fence consumes to EOF (no fake title/link leaks)", () => {
  const d = parseMarkdownDoc("---\nx: 1\n---\n# Real\n\nText [[Link]].\n\n~~~\n# Fake\n[[InCode]]\n");
  assert.equal(d.meta.title, "Real");
  assert.deepEqual(d.bodyLinks, ["Link"]);
});
