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

// ── collapsible sidebar (nav-group <details>) ─────────────────────────────────
// A focused harness: full control over STORY.groups + a localStorage pre-seed so
// we can assert the collapsed-state contract independently of the single-group mount().
function mountNav({ groups, docs, home = "Home", title = "T", seed } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
       <span id="brand-title"></span><span id="brand-sub"></span>
       <nav id="nav"></nav><main id="canvas"></main>
     </body></html>`,
    { runScripts: "outside-only", url: "http://localhost/" }
  );
  const { window } = dom;
  window.mermaid = { initialize() {}, render: () => Promise.resolve({ svg: "<svg></svg>" }) };
  window.echarts = { init: () => ({ setOption() {}, dispose() {}, resize() {} }) };
  if (seed) { try { for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v); } catch (e) { /* no storage */ } }
  window.STORY = { meta: { title, subtitle: "", home }, groups, docs, backlinks: {} };
  window.eval(readFileSync(resolve(LIB, "app.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return window;
}

const NAV_GROUPS = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "empty", label: "Empty" }];
const NAV_DOCS = {
  Home: { group: "a", icon: "file", meta: {}, html: "<p>h</p>" },
  Bx: { group: "b", icon: "file", meta: {}, html: "<p>b</p>" },
};

test("nav: each non-empty group is a <details> with a count badge and wrapped items", () => {
  const w = mountNav({ groups: NAV_GROUPS, docs: NAV_DOCS });
  const nav = w.document.getElementById("nav");
  const details = nav.querySelectorAll("details.nav-group");
  assert.equal(details.length, 2, "empty group is skipped");
  for (const d of details) {
    assert.ok(d.querySelector("summary.nav-group__label"), "summary header present");
    assert.ok(d.querySelector(".nav-group__chevron"), "chevron present");
    assert.ok(d.querySelector(".nav-group__items > .nav-item"), "items live inside the wrapper");
  }
  assert.equal(nav.querySelector('details[data-group="b"] .nav-group__count').textContent, "1", "count reflects item number");
  assert.ok(nav.querySelector('details[data-group="a"]').open, "groups default open");
});

test("nav: a persisted collapsed group renders closed; others stay open", () => {
  const w = mountNav({ groups: NAV_GROUPS, docs: NAV_DOCS, seed: { "bureau:nav:T": JSON.stringify(["b"]) } });
  const nav = w.document.getElementById("nav");
  assert.equal(nav.querySelector('details[data-group="b"]').open, false, "seeded-collapsed group is closed");
  assert.equal(nav.querySelector('details[data-group="a"]').open, true, "home group is open");
});

test("nav: navigating into a collapsed group force-opens it (current page stays visible)", () => {
  const w = mountNav({ groups: NAV_GROUPS, docs: NAV_DOCS, seed: { "bureau:nav:T": JSON.stringify(["b"]) } });
  const nav = w.document.getElementById("nav");
  assert.equal(nav.querySelector('details[data-group="b"]').open, false, "starts collapsed");
  w.location.hash = "#/Bx";
  w.dispatchEvent(new w.Event("hashchange"));
  assert.equal(nav.querySelector('details[data-group="b"]').open, true, "opens on navigation into it");
  // but a forced open must NOT rewrite the user's persisted collapse preference
  assert.deepEqual(JSON.parse(w.localStorage.getItem("bureau:nav:T")), ["b"], "force-open does not persist");
  // navigating away to another group re-collapses the forced-open group (restores what you left)
  w.location.hash = "#/Home";
  w.dispatchEvent(new w.Event("hashchange"));
  assert.equal(nav.querySelector('details[data-group="b"]').open, false, "re-collapses when you leave it");
  assert.deepEqual(JSON.parse(w.localStorage.getItem("bureau:nav:T")), ["b"], "still no persistence change");
});

// ── tabs hydration (Phase 3) ──────────────────────────────────────────────────
const TABS_HTML = '<div class="tabs">' +
  '<section class="tab-panel" role="tabpanel" data-tab="Overview"><p>OVERVIEW</p></section>' +
  '<section class="tab-panel" role="tabpanel" data-tab="Details"><p>DETAILS</p></section></div>';

test("runtime: .tabs hydrates into an ARIA tablist; first panel shown, rest hidden", () => {
  const { window } = mount(TABS_HTML);
  const box = window.document.querySelector(".tabs");
  assert.ok(box.classList.contains("tabs--ready"), "marked hydrated");
  const strip = box.querySelector('.tab-strip[role="tablist"]');
  assert.ok(strip, "tablist built");
  const btns = strip.querySelectorAll("button.tab-btn");
  assert.equal(btns.length, 2, "one tab button per panel");
  assert.equal(btns[0].textContent, "Overview");
  assert.equal(btns[0].getAttribute("aria-selected"), "true");
  assert.equal(btns[1].getAttribute("aria-selected"), "false");
  const panels = box.querySelectorAll(".tab-panel");
  assert.equal(panels[0].hidden, false, "first panel visible");
  assert.equal(panels[1].hidden, true, "second panel hidden");
  assert.ok(panels[0].getAttribute("aria-labelledby"), "panel linked to its tab");
});

test("runtime: clicking a tab switches the visible panel and aria-selected", () => {
  const { window } = mount(TABS_HTML);
  const box = window.document.querySelector(".tabs");
  const btns = box.querySelectorAll("button.tab-btn");
  const panels = box.querySelectorAll(".tab-panel");
  btns[1].dispatchEvent(new window.Event("click"));
  assert.equal(panels[0].hidden, true, "first panel hidden after switch");
  assert.equal(panels[1].hidden, false, "second panel shown");
  assert.equal(btns[1].getAttribute("aria-selected"), "true");
  assert.equal(btns[0].getAttribute("aria-selected"), "false");
});
