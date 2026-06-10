// Obsidian extras: callouts, #tags, ![[embeds]] (image + note transclusion),
// and [[Note#heading]] / [[#heading]] anchor links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { markdownToHtml, addHeadingIds, resolveImageEmbeds } from "../src/core/parse.mjs";
import { makeResolve } from "../src/runtime/pure.mjs";
import { slugify } from "../src/shared/slug.mjs";
import { buildSite } from "../src/build.mjs";

test("callout: > [!warning] → div.callout-warning with title + body", () => {
  const h = markdownToHtml("> [!warning] Spoiler\n> Lin betrays the court.\n");
  assert.match(h, /<div class="callout callout-warning"><div class="callout-title">Spoiler<\/div>/);
  assert.match(h, /Lin betrays the court/);
});

test("callout: a bare [!note] uses the type as its title", () => {
  assert.match(markdownToHtml("> [!note]\n> body\n"), /callout-note"><div class="callout-title">Note<\/div>/);
});

test("#tags → span.tag; nested a/b; skipped in code and inside [[#anchor]]", () => {
  const h = markdownToHtml("a #protagonist and #arc/early, but not `#code` nor [[#Background]]");
  assert.match(h, /<span class="tag" data-tag="protagonist">#protagonist<\/span>/);
  assert.match(h, /data-tag="arc\/early"/);
  assert.match(h, /<code>#code<\/code>/);
  assert.match(h, /\[\[#Background\]\]/);   // anchor link untouched (resolved later)
});

test("makeResolve: [[Doc#Heading]] → #/Doc?h=slug; [[#H]] uses selfId; missing flagged", () => {
  const r = makeResolve({ Lin: {}, Self: {} }, "Self");
  assert.match(r("Lin#Background"), /href="#\/Lin\?h=background"/);
  assert.match(r("#Local Bit"), /href="#\/Self\?h=local-bit"/);
  assert.match(r("Ghost#X"), /wikilink--missing/);
});

test("addHeadingIds: slugged + deduped; respects an author id", () => {
  const h = addHeadingIds('<h2>My Heading</h2><h2>My Heading</h2><h3 id="keep">x</h3>');
  assert.match(h, /<h2 id="my-heading">My Heading<\/h2>/);
  assert.match(h, /<h2 id="my-heading-2">My Heading<\/h2>/);
  assert.match(h, /<h3 id="keep">/);
});

test("resolveImageEmbeds: image resolves via index; missing → marker; note left for transclusion", () => {
  const idx = { "face.png": "assets/face.png" };
  assert.match(resolveImageEmbeds("![[face.png]]", idx), /<img class="wb-embed-img" src="assets\/face.png"/);
  assert.match(resolveImageEmbeds("![[gone.png]]", idx), /missing image: gone.png/);
  assert.equal(resolveImageEmbeds("![[Some Note]]", idx), "![[Some Note]]");
});

test("slugify: kebab; unicode preserved", () => {
  assert.equal(slugify("My Heading!"), "my-heading");
  assert.equal(slugify("Café Notes"), "café-notes");
});

test("build: ![[Note#Heading]] transcludes the section; missing → marker; no leftover markers", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-embed-"));
  const w = join(root, "gazette");
  mkdirSync(join(w, "people"), { recursive: true });
  writeFileSync(join(w, "_config.json"), JSON.stringify({ meta: { home: "Lin" } }));
  writeFileSync(join(w, "people", "wei.md"), "# Wei\n## Bio\nWei is the foil.\n");
  writeFileSync(join(w, "people", "lin.md"), "# Lin\n\n![[Wei#Bio]]\n\n![[Ghost]]\n");
  buildSite({ root, outDir: join(root, "dist"), now: "2026-06-10" });
  const c = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  const h = JSON.parse(c.match(/"Lin":\s*\{[\s\S]*?"html":\s*("(?:[^"\\]|\\.)*")/)[1]);
  assert.match(h, /<figure class="wb-embed">[\s\S]*?Bio[\s\S]*?Wei is the foil/);
  assert.match(h, /wb-embed-missing">⛔ missing embed: Ghost/);
  assert.doesNotMatch(h, /!\[\[/);
});
