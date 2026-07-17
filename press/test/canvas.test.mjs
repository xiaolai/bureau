import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { JSDOM } from "jsdom";
import { renderCanvasSvg } from "../src/render/canvas-svg.mjs";
import { buildSite } from "../src/build.mjs";

// Parse an <svg> fragment into a real DOM so assertions test the PARSED structure, not just
// a raw-string grep — a case-variant tag (<IMG>) or parser-equivalent unsafe markup would slip
// past a case-sensitive regex but not past querySelector.
const parseSvg = (svg) => new JSDOM("<!DOCTYPE html>" + svg).window.document;
const eventHandlerAttr = (el) => el.getAttributeNames().find((a) => /^on/i.test(a));

test("canvas: renders nodes + edges; node labels escaped (XSS-safe)", () => {
  const svg = renderCanvasSvg({
    nodes: [{ id: "a", x: 0, y: 0, text: "<img src=x onerror=alert(1)>" }, { id: "b", x: 300, y: 0, label: "B" }],
    edges: [{ fromNode: "a", toNode: "b" }],
  });
  assert.match(svg, /<rect/);
  assert.match(svg, /<line/);
  // raw-string guard, now case-insensitive so <IMG>/<Img> can't slip past. (An `onerror=`
  // grep would false-positive here — it survives as inert text inside &lt;…&gt;; the parsed
  // no-event-handler check below is the precise guard for that.)
  assert.doesNotMatch(svg, /<img/i);
  assert.match(svg, /&lt;img/);
  // parse the SVG and prove the hostile label produced NO element node and NO event handler
  const doc = parseSvg(svg);
  assert.equal(doc.querySelector("img"), null, "label text did not create a real <img> element");
  assert.equal(doc.querySelector("script"), null, "label text did not create a <script> element");
  const handled = [...doc.querySelectorAll("*")].find(eventHandlerAttr);
  assert.equal(handled, undefined, "no element carries an on* event-handler attribute");
  // the injected markup survives only as inert TEXT inside a <text> node
  assert.ok(
    [...doc.querySelectorAll("text")].some((t) => t.textContent.includes("<img")),
    "the injection is inert text content, not markup",
  );
});

test("canvas: a hostile numeric coordinate cannot break out of an SVG attribute (audit HIGH)", () => {
  const svg = renderCanvasSvg({ nodes: [{ id: "a", x: '0" onload="alert(1)', y: 0, width: '"/><script>x', height: 60 }], edges: [] });
  // raw-string guards (case-insensitive)
  assert.doesNotMatch(svg, /onload|<script/i);
  assert.match(svg, /x="0"/);   // hostile x coerced to 0
  // parse the SVG: every geometry/size attribute must be finite numeric, and no element may
  // carry an event-handler attribute — validates the attribute context, not just the substring.
  const doc = parseSvg(svg);
  assert.equal(doc.querySelector("script"), null, "the '\"/><script>' width payload did not create a <script>");
  const GEOM = new Set(["x", "y", "width", "height", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry"]);
  const shapes = [...doc.querySelectorAll("rect, line, text, circle, path")];
  assert.ok(shapes.length > 0, "the SVG has shape elements to validate");
  for (const el of [...doc.querySelectorAll("*")]) {
    assert.equal(eventHandlerAttr(el), undefined, `<${el.tagName}> must not carry an event-handler attribute`);
  }
  for (const el of shapes) {
    for (const name of el.getAttributeNames()) {
      if (!GEOM.has(name.toLowerCase())) continue;
      const v = el.getAttribute(name);
      assert.ok(Number.isFinite(Number(v)), `geometry attribute ${name}="${v}" on <${el.tagName}> must be finite numeric`);
    }
  }
});

test("canvas: a docs/*.canvas becomes a read-only board view", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-canvas-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "A" }, groups: [{ id: "g", label: "G" }] }));
  writeFileSync(join(docsDir, "a.html"), '<article data-group="g"><h1>A</h1>x</article>');
  writeFileSync(join(docsDir, "map.canvas"), JSON.stringify({ nodes: [{ id: "n", x: 0, y: 0, text: "hello" }], edges: [] }));
  buildSite({ root, docsDir, outDir: join(root, "dist"), now: "2026-06-09" });
  const content = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  assert.match(content, /Canvas · map/);

  // load the emitted STORY and prove the canvas doc is a read-only SVG view — not just that its
  // title string appears in the bundle. The doc must carry rendered SVG (with the node's box +
  // label) and NO editable text body / form controls.
  const win = {};
  new Function("window", content)(win);   // content.js is `window.STORY = {…}`
  const doc = win.STORY.docs["Canvas · map"];
  assert.ok(doc, "canvas doc present in STORY.docs");
  assert.equal(doc.meta.type, "JSON Canvas (read-only)", "canvas doc advertises itself as read-only");
  assert.ok(doc.body == null && doc.html == null, "canvas view has no editable text body (read-only SVG view)");
  assert.ok(doc.svg && /<svg[\s>]/.test(doc.svg), "canvas doc renders as an SVG view");
  const svgDoc = parseSvg(doc.svg);
  assert.ok(svgDoc.querySelector("rect"), "the canvas node rendered as an SVG <rect>");
  assert.ok(
    [...svgDoc.querySelectorAll("text")].some((el) => el.textContent.includes("hello")),
    "the canvas node label is present in the rendered SVG",
  );
  assert.equal(svgDoc.querySelector("input, textarea, button, form, [contenteditable]"), null, "no editable controls in the read-only canvas view");
});
