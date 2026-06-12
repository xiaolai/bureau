// Runtime harness — exercises the REAL browser bundle (template/lib/app.js) in
// jsdom against the new content model: doc bodies arrive as pre-sanitized `html`,
// the runtime mounts them and HYDRATES widgets (.viz tables/charts, backlinks, nav).
// ECharts is stubbed (records the option it's handed); js-yaml + PapaParse are the
// real vendored parsers so the data path is genuine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "template", "lib");

function mount(html, { extraDocs = {}, backlinks = {} } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
       <span id="brand-title"></span><span id="brand-sub"></span>
       <nav id="nav"></nav><main id="canvas"></main>
     </body></html>`,
    { runScripts: "outside-only", url: "http://localhost/" }
  );
  const { window } = dom;
  window.atob = atob; window.btoa = btoa; window.unescape = unescape; window.escape = escape;
  window.mermaid = { initialize() {}, render: () => Promise.resolve({ svg: "<svg></svg>" }) };
  // record echarts wiring without the heavy lib
  const charts = [];
  window.echarts = { init: () => ({ setOption: (o) => charts.push(o), dispose() {}, resize() {} }) };
  // real vendored parsers (small) — genuine CSV/YAML path
  window.eval(readFileSync(resolve(LIB, "papaparse.min.js"), "utf8"));
  window.eval(readFileSync(resolve(LIB, "js-yaml.min.js"), "utf8"));
  window.STORY = {
    meta: { title: "T", subtitle: "", home: "Home" },
    groups: [{ id: "g", label: "G" }],
    docs: Object.assign({ Home: { group: "g", icon: "file", meta: {}, html } }, extraDocs),
    backlinks,
  };
  window.eval(readFileSync(resolve(LIB, "app.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return { window, charts };
}

test("runtime: pre-sanitized html mounts; a stray <script> in it does not execute", () => {
  const { window } = mount("<h1>Title</h1><p>plain</p><script>window.PWNED=1</" + "script>");
  const canvas = window.document.getElementById("canvas");
  assert.equal(window.PWNED, undefined, "innerHTML-inserted script never runs");
  assert.match(canvas.textContent, /Title/, "doc rendered");
});

test("runtime: a malicious nav title does not break out of attributes", () => {
  const { window } = mount("<p>body</p>", {
    extraDocs: { '"><img src=x onerror=window.PWNED=1>': { group: "g", icon: "file", meta: {}, html: "<p>x</p>" } },
  });
  const nav = window.document.getElementById("nav");
  assert.equal(window.PWNED, undefined);
  assert.equal(nav.querySelector("img[onerror]"), null);
});

test("runtime: a .viz table hydrates into a wb-table with the CSV data", () => {
  const { window } = mount('<div class="viz" data-type="table" data-format="csv">name,n\nLin,3\nWei,9</div>');
  const canvas = window.document.getElementById("canvas");
  const table = canvas.querySelector("table.wb-table");
  assert.ok(table, "table rendered");
  assert.match(table.textContent, /Lin/);
  assert.ok(table.querySelector('th[data-col="1"].num'), "numeric column flagged for sorting");
});

test("runtime: a .viz chart hands ECharts an option with a series", () => {
  const { charts } = mount('<div class="viz" data-type="chart" data-kind="bar" data-format="csv">a,b\n1,2\n3,4</div>');
  assert.equal(charts.length, 1, "echarts.setOption called once");
  assert.ok(Array.isArray(charts[0].series) && charts[0].series.length >= 1, "option carries a series");
  assert.equal(charts[0].series[0].type, "bar");
});

test("runtime: a .viz graph (JSON nodes/edges) hands ECharts a graph series", () => {
  const { charts } = mount('<div class="viz" data-type="graph" data-format="json">{"nodes":["A","B"],"edges":[["A","B"]]}</div>');
  assert.equal(charts.length, 1);
  assert.equal(charts[0].series[0].type, "graph");
  assert.equal(charts[0].series[0].data.length, 2);
});

test("runtime: the backlink panel renders from STORY.backlinks", () => {
  const { window } = mount("<p>home</p>", {
    extraDocs: { Beta: { group: "g", icon: "file", meta: {}, html: "<p>x</p>" } },
    backlinks: { Home: [{ source: "Beta", excerpt: "Beta mentions home" }] },
  });
  const canvas = window.document.getElementById("canvas");
  const card = canvas.querySelector(".backlink-card");
  assert.ok(card, "backlink card rendered");
  assert.match(card.textContent, /Beta/);
  assert.match(card.textContent, /Beta mentions home/);
});
