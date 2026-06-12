// Build-time content boundary: sanitizeBody (drops scripts/handlers/unknown tags,
// keeps viz/mermaid/class/data-*) + resolveLinks (resolves [[..]] / <a data-wiki>,
// escapes labels, leaves code-fenced links literal). Pure Node — no jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBody } from "../src/services/sanitize.mjs";
import { resolveLinks, rewriteWikiRef } from "../src/core/parse.mjs";
import { makeResolve } from "../src/runtime/pure.mjs";

test("sanitizeBody: strips <script> + event handlers, keeps viz/mermaid/class/data-*", () => {
  const out = sanitizeBody(
    '<article data-group="g"><p class="lead" onclick="bad()">hi</p>' +
    "<script>window.PWNED=1</" + "script>" +
    '<div class="viz" data-type="chart" data-kind="bar">a,b</div>' +
    '<div class="mermaid">graph LR;A--&gt;B</div></article>'
  );
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /onclick/);
  assert.match(out, /class="lead"/);
  assert.match(out, /class="viz"/);
  assert.match(out, /data-type="chart"/);
  assert.match(out, /class="mermaid"/);
});

test("sanitizeBody: a hostile <img onerror> loses its handler", () => {
  const out = sanitizeBody('<p><img src=x onerror="window.PWNED=1"></p>');
  assert.doesNotMatch(out, /onerror/);
});

test("resolveLinks: resolves a real [[Target]] to a wiki anchor; missing → no href", () => {
  const resolve = makeResolve({ Wei: {} });
  const real = resolveLinks("see [[Wei]]", resolve);
  assert.match(real, /class="wikilink" href="#\/Wei"/);
  const missing = resolveLinks("see [[Ghost]]", resolve);
  assert.match(missing, /wikilink--missing/);
  assert.doesNotMatch(missing, /href=/);
});

test("resolveLinks: <a data-wiki> resolves and an HTML label is flattened + escaped", () => {
  const resolve = makeResolve({ Wei: {} });
  const out = resolveLinks('<a data-wiki="Wei">the <b>foil</b></a>', resolve);
  assert.match(out, /class="wikilink" href="#\/Wei"/);
  assert.doesNotMatch(out, /<b>/); // label flattened to text, then escaped
});

test("resolveLinks: [[..]] inside <pre>/<code> stays literal (mirrors model link semantics)", () => {
  const resolve = makeResolve({ Wei: {} });
  const out = resolveLinks("<p>[[Wei]]</p><pre>[[Wei]]</pre><code>[[Wei]]</code>", resolve);
  assert.match(out, /class="wikilink"/);                 // prose resolved
  assert.match(out, /<pre>\[\[Wei\]\]<\/pre>/);          // fenced literal
  assert.match(out, /<code>\[\[Wei\]\]<\/code>/);        // inline-code literal
});

test("full render path (resolve → sanitize) neutralizes hostile content while keeping links", () => {
  const render = (h) => sanitizeBody(resolveLinks(h, makeResolve({ Wei: {} })));
  const out = render('<p>[[Wei]] <img src=x onerror="window.PWNED=1"></p>');
  assert.doesNotMatch(out, /onerror/);
  assert.match(out, /class="wikilink" href="#\/Wei"/);
});

test("sanitizeBody: data: dropped on <a>, kept on <img>", () => {
  assert.doesNotMatch(sanitizeBody('<a href="data:text/html,x">x</a>'), /data:text\/html/);
  assert.match(sanitizeBody('<img src="data:image/png;base64,iVBOR">'), /data:image\/png/);
});

test("resolveLinks: unquoted data-wiki resolves; numeric-entity target decodes once", () => {
  const resolve = makeResolve({ Wei: {}, "A&B": {} });
  assert.match(resolveLinks("<a data-wiki=Wei>w</a>", resolve), /class="wikilink" href="#\/Wei"/);
  assert.doesNotMatch(resolveLinks('<a data-wiki="A&#38;B">l</a>', resolve), /wikilink--missing/);
});

test("rewriteWikiRef: a quote in the new title is escaped, not injected as an attribute", () => {
  const { html } = rewriteWikiRef('<article data-allies="[[Old]]"></article>', "Old", 'New" onx="y');
  assert.doesNotMatch(html, / onx="y"/);
  assert.match(html, /&quot;/);
});
