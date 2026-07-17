// Markdown / Obsidian lane: .md docs render to HTML at build, with frontmatter
// metadata, [[wiki-links]], typed relations, and ```viz / ```mermaid fences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import vm from "node:vm";
import { markdownToHtml, parseMarkdownDoc } from "../src/core/parse.mjs";
import { buildModel } from "../src/core/model.mjs";
import { buildSite } from "../src/build.mjs";

// Load the generated STORY object the way the browser does — evaluate content.js in a
// sandbox with a `window` global — instead of regex-scraping its serialized JS, which
// breaks on any field-ordering or escaping change. Returns window.STORY.
function loadStory(distDir) {
  const src = readFileSync(join(distDir, "lib", "content.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.STORY;
}

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

test("markdownToHtml: ```dot fence → dot widget div (engine/roughness carried, source escaped)", () => {
  const h = markdownToHtml("```dot engine=neato roughness=1.6\ndigraph { a -> b; c -> \"<x>\" }\n```\n");
  assert.match(h, /<div class="dot" data-engine="neato" data-roughness="1.6">digraph/);
  assert.match(h, /a -&gt; b/);          // DOT source is HTML-escaped, so it survives the sanitizer
  assert.match(h, /&quot;&lt;x&gt;&quot;/); // '<' in a label never reaches the DOM as markup
  const plain = markdownToHtml("```dot\ndigraph{a->b}\n```\n");
  assert.match(plain, /<div class="dot">digraph\{a-&gt;b\}/); // no options → bare div, engine defaults at runtime
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

test("build: a .md doc renders to HTML, takes its folder section, and ships", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-md-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = join(root, "gazette");
  mkdirSync(join(w, "people"), { recursive: true });
  writeFileSync(join(w, "_config.json"), JSON.stringify({ meta: { home: "Overview" } }));
  writeFileSync(join(w, "00-overview.html"), '<article data-title="Overview"><h1>Overview</h1><p>See [[Wei]].</p></article>');
  writeFileSync(join(w, "people", "wei.md"), "---\nicon: user\n---\n# Wei\n\nA **foil**. Back to [[Overview]].\n");
  const m = buildModel({ docsDir: w });
  assert.equal(m.nodes["Wei"].group, "people");   // folder section
  assert.equal(m.nodes["Wei"].icon, "user");
  buildSite({ root, outDir: join(root, "dist"), now: "2026-06-10" });
  const html = loadStory(join(root, "dist")).docs["Wei"].html; // structured read, not a regex scrape
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
  // the fallback must PRESERVE the content as a code block — a renderer that dropped the
  // text entirely would also satisfy the absence-of-tabs check above, so assert it survives.
  assert.match(html, /<pre><code[^>]*>just text, no markers/, "fallback keeps the text as a code block");
});

test("markdownToHtml: a === line inside a panel's nested code fence is body, not a tab marker", () => {
  const html = markdownToHtml("```tabs\n=== Real\nbefore\n~~~\n=== not a tab\n~~~\nafter\n=== Second\nx\n```\n");
  assert.equal((html.match(/class="tab-panel"/g) || []).length, 2, "exactly two real panels");
  assert.match(html, /data-tab="Real"/);
  assert.match(html, /data-tab="Second"/);
  assert.doesNotMatch(html, /data-tab="not a tab"/, "marker inside a code fence does not open a panel");
});
