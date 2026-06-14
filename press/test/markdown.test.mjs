// Markdown / Obsidian lane: .md docs render to HTML at build, with frontmatter
// metadata, [[wiki-links]], typed relations, and ```viz / ```mermaid fences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { markdownToHtml, parseMarkdownDoc } from "../src/core/parse.mjs";
import { buildModel } from "../src/core/model.mjs";
import { buildSite } from "../src/build.mjs";

test("markdownToHtml: prose renders; no markdown literals leak", () => {
  const h = markdownToHtml("# H\n\nsome **bold** and a [[Lin]] link\n\n- one\n- two\n");
  assert.match(h, /<h1>H<\/h1>/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /<ul>\s*<li>one<\/li>/);
  assert.match(h, /\[\[Lin\]\]/);            // wiki-link survives as text for resolveLinks
  assert.doesNotMatch(h, /\*\*bold\*\*/);
  assert.doesNotMatch(h, /(^|\n)#{1,6}\s/);
});

test("markdownToHtml: fences → widget divs", () => {
  const h = markdownToHtml("```chart kind=bar format=csv\na,b\n1,2\n```\n\n```mermaid\ngraph LR\nA-->B\n```\n");
  assert.match(h, /<div class="viz" data-type="chart" data-kind="bar" data-format="csv">a,b/);
  assert.match(h, /<div class="mermaid">graph LR/);
});

test("parseMarkdownDoc: frontmatter meta + typed relation + code-aware body links", () => {
  const p = parseMarkdownDoc("---\ntitle: Lin\nicon: user\nstatus: draft\ncontradicts: [[Villain]]\n---\n# Heading\nsee [[Wei]] and `[[InCode]]` and\n```\n[[Fenced]]\n```\n");
  assert.equal(p.meta.title, "Lin");          // frontmatter wins over the heading
  assert.equal(p.meta.icon, "user");
  assert.equal(p.metaChips.status, "draft");
  assert.deepEqual(p.edges, [{ target: "Villain", edgeType: "contradicts" }]);
  assert.deepEqual(p.bodyLinks, ["Wei"]);      // inline + fenced code excluded
});

test("parseMarkdownDoc: title falls back to the first ATX heading", () => {
  assert.equal(parseMarkdownDoc("# The Title\n\nbody").meta.title, "The Title");
});

test("build: a .md doc renders to HTML, takes its folder section, and ships", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-md-"));
  const w = join(root, "gazette");
  mkdirSync(join(w, "people"), { recursive: true });
  writeFileSync(join(w, "_config.json"), JSON.stringify({ meta: { home: "Overview" } }));
  writeFileSync(join(w, "00-overview.html"), '<article data-title="Overview"><h1>Overview</h1><p>See [[Wei]].</p></article>');
  writeFileSync(join(w, "people", "wei.md"), "---\nicon: user\n---\n# Wei\n\nA **foil**. Back to [[Overview]].\n");
  const m = buildModel({ docsDir: w });
  assert.equal(m.nodes["Wei"].group, "people");   // folder section
  assert.equal(m.nodes["Wei"].icon, "user");
  buildSite({ root, outDir: join(root, "dist"), now: "2026-06-10" });
  const content = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  const html = JSON.parse(content.match(/"Wei":\s*\{[\s\S]*?"html":\s*("(?:[^"\\]|\\.)*")/)[1]);
  assert.match(html, /<h1[^>]*>Wei<\/h1>/);
  assert.match(html, /<strong>foil<\/strong>/);
  assert.match(html, /class="wikilink"[^>]*href="#\/Overview"/); // [[Overview]] resolved
});

test("markdownToHtml: ```tabs renders each panel's markdown into a tab-panel section", () => {
  const html = markdownToHtml("```tabs\n=== Overview\nThis is the **overview**.\n=== Details\nHas `code` and a [[Link]].\n```\n");
  assert.match(html, /<div class="tabs">/, "tabs container emitted");
  assert.equal((html.match(/class="tab-panel"/g) || []).length, 2, "one section per panel");
  assert.match(html, /data-tab="Overview"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /<strong>overview<\/strong>/, "panel body rendered as markdown");
  assert.match(html, /\[\[Link\]\]/, "wiki-link left raw for downstream resolution");
});

test("markdownToHtml: a ```tabs with no === markers falls back to a plain code block", () => {
  const html = markdownToHtml("```tabs\njust text, no markers\n```\n");
  assert.doesNotMatch(html, /class="tabs"/, "no panels → not a tabs widget");
});
