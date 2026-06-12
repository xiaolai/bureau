import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { renderCanvasSvg } from "../src/render/canvas-svg.mjs";
import { buildSite } from "../src/build.mjs";

test("canvas: renders nodes + edges; node labels escaped (XSS-safe)", () => {
  const svg = renderCanvasSvg({
    nodes: [{ id: "a", x: 0, y: 0, text: "<img src=x onerror=alert(1)>" }, { id: "b", x: 300, y: 0, label: "B" }],
    edges: [{ fromNode: "a", toNode: "b" }],
  });
  assert.match(svg, /<rect/);
  assert.match(svg, /<line/);
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img/);
});

test("canvas: a hostile numeric coordinate cannot break out of an SVG attribute (audit HIGH)", () => {
  const svg = renderCanvasSvg({ nodes: [{ id: "a", x: '0" onload="alert(1)', y: 0, width: '"/><script>x', height: 60 }], edges: [] });
  assert.doesNotMatch(svg, /onload|<script/);
  assert.match(svg, /x="0"/);   // hostile x coerced to 0
});

test("canvas: a docs/*.canvas becomes a read-only board view", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-canvas-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "A" }, groups: [{ id: "g", label: "G" }] }));
  writeFileSync(join(docsDir, "a.html"), '<article data-group="g"><h1>A</h1>x</article>');
  writeFileSync(join(docsDir, "map.canvas"), JSON.stringify({ nodes: [{ id: "n", x: 0, y: 0, text: "hello" }], edges: [] }));
  buildSite({ root, docsDir, outDir: join(root, "dist"), now: "2026-06-09" });
  const content = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  assert.match(content, /Canvas · map/);
});
