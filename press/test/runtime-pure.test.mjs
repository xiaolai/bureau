// Unit tests for the render engine's pure logic — now importable in Node thanks to
// the runtime modularization (previously only reachable via the jsdom harness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  nfc, makeResolve, stripWiki, injectStyle, icon, ICONS,
} from "../src/runtime/pure.mjs";
import { escapeHtml } from "../src/shared/escape.mjs";
import { bundleRuntime } from "../src/build-runtime.mjs";

const APP_JS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "template", "lib", "app.js");

test("escape: the one shared escaper handles all five chars", () => {
  assert.equal(escapeHtml('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("nfc: decomposed input is folded to composed NFC form; null passes through", () => {
  // "A" + combining ring above (U+030A) must compose to the single code point Å (U+00C5),
  // so two byte-different spellings of the same name share one identity key.
  assert.equal(nfc("A\u030A"), "\u00C5"); // decomposed → composed
  assert.equal(nfc("A\u030A").length, 1);        // two code points fold to one
  assert.equal(nfc(null), null); // null-safe: identity is never forced onto a missing value
});

test("makeResolve: existing target → live wikilink with hash href", () => {
  const resolve = makeResolve({ "Café": {} });
  const html = resolve("Café", "Café");
  assert.match(html, /class="wikilink"/);
  assert.match(html, /href="#\/Caf%C3%A9"/);
});

test("makeResolve: missing target → no href, marked missing", () => {
  const html = makeResolve({})("Ghost", "Ghost");
  assert.match(html, /wikilink--missing/);
  assert.doesNotMatch(html, /href=/);
});

test("makeResolve: a hostile label is escaped, not injected (XSS)", () => {
  const html = makeResolve({})("x", '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("injectStyle: flowchart gets classDef, sequence does not; palette is applied", () => {
  assert.match(injectStyle("graph LR\n A-->B"), /classDef default/);
  assert.doesNotMatch(injectStyle("sequenceDiagram\n A->>B: x"), /classDef/);
  assert.match(injectStyle("graph LR\n A-->B", { fill: "#111", stroke: "#222", color: "#333", link: "#444" }), /fill:#111,stroke:#222,color:#333/);
});

test("stripWiki flattens [[links]] to plain names", () => {
  assert.equal(stripWiki("see [[Beta|the hero]]"), "see the hero");
  assert.equal(stripWiki("plain [[Café]] here"), "plain Café here");
});

test("icon falls back to file for unknown names", () => {
  assert.ok(icon("nope").includes(ICONS.file));
});

test("bundle: committed app.js is up-to-date with src/runtime (no stale bundle)", () => {
  assert.equal(readFileSync(APP_JS, "utf8"), bundleRuntime(),
    "template/lib/app.js is stale — run `npm run build:runtime` and commit");
});
