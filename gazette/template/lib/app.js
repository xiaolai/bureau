// ⚠ auto-generated. Do not edit. Source: src/runtime/*.mjs + src/shared/escape.mjs.
// rebuild with: npm run build:runtime (CI verifies this file is current).
(function () {
"use strict";

// shared/escape — the ONE HTML-escaper, used by both the Node build (services/
// sanitize) and the browser runtime bundle (src/runtime). No second copy (grill L2).

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// shared/slug — heading-anchor slugs. Used at build for heading ids and for the
// `?h=` target of `[[Note#Heading]]` wiki-links, so both sides agree. Unicode-aware
// (CJK headings keep their characters). Concatenated into the bundle by build-runtime.
// PLAIN-TEXT slugger: callers that pass rendered HTML (e.g. addHeadingIds) must strip tags
// FIRST. Stripping `<...>` here would also eat literal `A < B` heading text and desync the
// anchor from the wiki-link slug (which is always plain text), so it's intentionally absent.
function slugify(s) {
  return String(s == null ? "" : s)
    .normalize("NFC")                        // composed/decomposed forms → one slug
    .toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")       // keep letters/numbers/space/_/-
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// runtime/pure — DOM-free render logic, unit-testable in Node. Concatenated into
// the browser bundle by src/build-runtime.mjs. No window/document here.

// identity: same NFC rule as the build/model (grill H3)
function nfc(s) { return s == null ? s : String(s).normalize("NFC"); }

// [[target|label]] matcher with two capture groups (used by stripWiki)
const WIKI_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

// render one [[wiki-link]] to its anchor HTML. Supports `[[Doc#Heading]]` (link to a
// heading) and `[[#Heading]]` (same doc — `selfId`). Pure + XSS-critical: label/title
// escaped; missing targets get no href (no javascript: URL).
function makeResolve(docs, selfId) {
  return function resolve(target, label) {
    const hi = String(target).indexOf("#");
    const sameDoc = hi === 0;
    let docName = hi < 0 ? target : target.slice(0, hi);
    const anchor = hi < 0 ? "" : target.slice(hi + 1).trim();
    if (sameDoc && selfId != null) docName = String(selfId);
    const t = nfc(docName);
    // own-property test: a target like "constructor" must resolve as MISSING, not match an
    // inherited Object member (docs may be a plain object keyed by user titles).
    const exists = Object.prototype.hasOwnProperty.call(docs, t);
    let href = "";
    if (exists) { href = "#/" + encodeURIComponent(t); if (anchor) href += "?h=" + encodeURIComponent(slugify(anchor)); }
    const cls = exists ? "wikilink" : "wikilink wikilink--missing";
    const attr = exists ? 'href="' + href + '"' : 'aria-disabled="true"';
    const title = exists ? (anchor ? t + " › " + anchor : t) : (docName + " (missing)");
    const display = label || (sameDoc ? anchor : String(target).replace("#", " › "));
    return '<a class="' + cls + '" ' + attr + ' title="' + escapeAttr(title) +
      '"><span class="wikilink__bracket">[[</span>' + escapeHtml(display) +
      '<span class="wikilink__bracket">]]</span></a>';
  };
}

// strip [[..]] to plain names inside mermaid code (diagrams don't resolve links)
function stripWiki(s) {
  return s.replace(WIKI_RE, (_, n, l) => (l || n).trim());
}

// inject flowchart node colors as in-diagram DSL (mermaid's local build only honors
// DSL, not page CSS). `palette` lets the theme drive node fill/stroke/text/edge so a
// dark theme's diagrams aren't stuck on the light default; dom.mjs reads it from CSS
// vars. Pure + DOM-free (palette is injected), so it stays Node-testable.
function injectStyle(code, palette) {
  const p = palette || {};
  const fill = p.fill || "#efeae0", stroke = p.stroke || "#ddd6c8", color = p.color || "#22201b", link = p.link || "#b8b0a0";
  const c = stripWiki(code).replace(/\s+$/, "");
  if (!/^\s*(graph|flowchart)\b/.test(c)) return c;
  return c +
    "\n  classDef default fill:" + fill + ",stroke:" + stroke + ",color:" + color + ";" +
    "\n  linkStyle default stroke:" + link + ",stroke-width:1.4px;";
}

function metaRow(meta) {
  if (!meta) return "";
  return '<div class="doc-meta">' +
    ["type", "status", "words", "age"].filter((k) => meta[k])
      .map((k) => '<span class="meta-chip meta-chip--' + k + '">' + escapeHtml(meta[k]) + "</span>").join("") +
    "</div>";
}

const ICONS = {
  home: '<path d="M3 9.5 10 4l7 5.5M5 8.5V16h10V8.5"/>',
  user: '<circle cx="10" cy="7" r="3"/><path d="M4.5 16c.6-3 2.8-4.5 5.5-4.5S15 13 15.5 16"/>',
  globe: '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2 2.2 2 10.8 0 13M10 3.5c-2 2.2-2 10.8 0 13"/>',
  file: '<path d="M6 3h5l3 3v11H6z"/><path d="M11 3v3h3"/>',
  book: '<path d="M5 4h5v12H6a1 1 0 0 1-1-1z"/><path d="M15 4h-5v12h4a1 1 0 0 0 1-1z"/>',
  share: '<circle cx="6" cy="10" r="2"/><circle cx="14" cy="5" r="2"/><circle cx="14" cy="15" r="2"/><path d="M7.8 9 12.3 6M7.8 11l4.5 3"/>',
  clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4l3 2"/>',
  seal: '<rect x="4.5" y="4.5" width="11" height="11" rx="1.5"/><path d="M8 8h4M8 10.5h4M8 13h2.5"/>',
  swords: '<path d="M4 4l7 7M13 4l3 0 0 3-7 7M4 13l3 3M14 13l-3 3"/>',
  heart: '<path d="M10 16S4 12 4 7.8A2.8 2.8 0 0 1 10 6a2.8 2.8 0 0 1 6 1.8C16 12 10 16 10 16z"/>',
};
function icon(n) {
  return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n] || ICONS.file) + "</svg>";
}

// runtime/viz — pure, lib-free data-viz core. Parsers are INJECTED (the browser
// passes the vendored globals JSON / js-yaml / PapaParse; Node tests pass the same
// npm libs), so every builder here is a pure function: unit-tested in Node AND
// concatenated into the offline app.js. No window/document and no echarts import —
// the chart/graph builders return plain ECharts *option objects*; echarts.setOption
// runs in dom.mjs. Bundled after escape.mjs + pure.mjs by src/build-runtime.mjs.

// warm default palette (paper/ink/cinnabar family); dom.mjs overrides from CSS vars.
const VIZ_PALETTE = ["#b5642f", "#3f6f5b", "#9a7b3f", "#6a5acd", "#a23b52", "#4a7fa5", "#8a8d3f", "#9c6b4f"];

function num(v) { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : 0; }
function isNumeric(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") { const t = v.trim(); return t !== "" && Number.isFinite(Number(t)); }
  return false;
}

// ── format sniffing ─────────────────────────────────────────────────────────
// JSON when it opens with { or [ ; Markdown when a pipe header sits over a |---|
// separator; CSV when the head lines are consistently delimited; else YAML. An
// explicit data-format always overrides this upstream.
function detectFormat(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return "json";
  if (t[0] === "{" || t[0] === "[") return "json";
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== "");
  // markdown table: a pipe row followed by a dashed separator row (| --- | --- |)
  if (lines.length >= 2 && lines[0].indexOf("|") >= 0 && /-/.test(lines[1]) && /^[\s|:-]+$/.test(lines[1])) return "markdown";
  for (const d of [",", "\t", ";"]) {
    if (lines[0].indexOf(d) >= 0) {
      const n = lines[0].split(d).length;
      if (n >= 2 && lines.slice(0, 5).every((l) => Math.abs(l.split(d).length - n) <= 1)) return "csv";
    }
  }
  return "yaml";
}

// parse a GitHub-flavored markdown table → { columns, rows } (numbers coerced).
// Pure (no injected parser needed). Tolerates missing outer pipes + a separator row.
function parseMarkdownTable(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.indexOf("|") >= 0);
  if (lines.length < 1) return { columns: [], rows: [] };
  // split on unescaped pipes only, then unescape \| inside each cell (GFM)
  const cells = (l) => { let s = l.trim(); if (s.startsWith("|")) s = s.slice(1); if (s.endsWith("|")) s = s.slice(0, -1); return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")); };
  const columns = cells(lines[0]);
  const isSep = lines[1] && /^[\s|:-]+$/.test(lines[1]) && /-/.test(lines[1]);
  const body = lines.slice(isSep ? 2 : 1);
  const numish = (v) => { const s = String(v).trim(); return s !== "" && Number.isFinite(Number(s)) ? Number(s) : v; };
  return { columns, rows: body.map((l) => cells(l).map(numish)) };
}

// dispatch to a parser. P = { json, yaml, csv } injected (csv → array of row-objects
// via PapaParse header mode); markdown is parsed in-house (pure, no lib).
function parseData(text, format, P) {
  const f = (!format || format === "auto") ? detectFormat(text) : String(format).toLowerCase();
  if (f === "markdown" || f === "md") return parseMarkdownTable(text);
  if (f === "json") return P.json(text);
  if (f === "csv") return P.csv(text);
  return P.yaml(text);
}

// any parsed shape → { columns:string[], rows:any[][] }. Accepts {columns,rows},
// array-of-objects (CSV/JSON), array-of-arrays (first row = header), array of
// primitives, or a plain key→value object.
function normalizeTabular(value) {
  if (value && Array.isArray(value.columns) && Array.isArray(value.rows)) return { columns: value.columns.map(String), rows: value.rows };
  if (Array.isArray(value)) {
    if (!value.length) return { columns: [], rows: [] };
    if (Array.isArray(value[0])) return { columns: value[0].map(String), rows: value.slice(1) };
    if (value[0] && typeof value[0] === "object") {
      const columns = [];
      // tolerate a mixed array (e.g. [{a:1}, null, 5]) — only object rows contribute keys/cells
      value.forEach((o) => { if (o && typeof o === "object") Object.keys(o).forEach((k) => { if (columns.indexOf(k) < 0) columns.push(k); }); });
      return { columns, rows: value.map((o) => columns.map((c) => (o && typeof o === "object" && o[c] != null ? o[c] : ""))) };
    }
    return { columns: ["value"], rows: value.map((v) => [v]) };
  }
  if (value && typeof value === "object") return { columns: ["key", "value"], rows: Object.entries(value).map(([k, v]) => [k, v]) };
  return { columns: [], rows: [] };
}

// { columns, rows } → sortable, numeric-aligned HTML table. Numeric columns get
// class="num" (right-aligned + sorted numerically by dom.mjs). All cells escaped.
function tableToHtml(tab) {
  const columns = tab.columns || [], rows = tab.rows || [];
  if (!columns.length) return '<div class="viz-error">empty table</div>';
  const numCol = columns.map((_, c) => rows.length > 0 && rows.every((r) => r[c] == null || r[c] === "" || isNumeric(r[c])));
  let h = '<div class="wb-table-wrap"><table class="wb-table"><thead><tr>';
  columns.forEach((col, c) => {
    h += '<th data-col="' + c + '"' + (numCol[c] ? ' class="num"' : "") + ' tabindex="0" role="button" aria-sort="none">' +
      escapeHtml(String(col)) + '<span class="wb-sort" aria-hidden="true"></span></th>';
  });
  h += "</tr></thead><tbody>";
  rows.forEach((r) => {
    h += "<tr>";
    columns.forEach((_, c) => { const v = r[c]; h += "<td" + (numCol[c] ? ' class="num"' : "") + ">" + escapeHtml(v == null ? "" : String(v)) + "</td>"; });
    h += "</tr>";
  });
  return h + "</tbody></table></div>";
}

// { columns, rows } + kind → ECharts option. First column is the category/x axis;
// each remaining column is a series. kind: bar|line|area|pie|donut|scatter.
function buildChartOption(kind, tab, opts) {
  opts = opts || {};
  const palette = opts.palette || VIZ_PALETTE;
  const columns = tab.columns || [], rows = tab.rows || [];
  const k = String(kind || "bar").toLowerCase();
  const title = opts.title ? { text: String(opts.title), left: "center", textStyle: { fontSize: 13, fontWeight: 500 } } : undefined;

  if (k === "pie" || k === "donut") {
    return clean({
      color: palette, title, tooltip: { trigger: "item" }, legend: { bottom: 0, type: "scroll" },
      series: [{ type: "pie", radius: k === "donut" ? ["42%", "70%"] : "66%", center: ["50%", "48%"],
        data: rows.map((r) => ({ name: String(r[0]), value: num(r[1]) })), label: { fontSize: 11 } }],
    });
  }
  if (k === "scatter") {
    return clean({
      color: palette, title, tooltip: { trigger: "item" }, legend: { bottom: 0, type: "scroll" },
      grid: { left: 48, right: 20, top: title ? 36 : 20, bottom: 44, containLabel: true },
      xAxis: { type: "value", name: String(columns[0] || "") }, yAxis: { type: "value" },
      series: columns.slice(1).map((name, i) => ({ name: String(name), type: "scatter", symbolSize: 9,
        data: rows.map((r) => [num(r[0]), num(r[i + 1])]) })),
    });
  }
  // bar | line | area
  const cats = rows.map((r) => String(r[0]));
  const series = columns.slice(1).map((name, i) => {
    const s = { name: String(name), type: k === "bar" ? "bar" : "line", data: rows.map((r) => num(r[i + 1])) };
    if (k === "area") s.areaStyle = {};
    if (k === "line" || k === "area") { s.smooth = !!opts.smooth; s.symbolSize = 6; }
    if (opts.stack && k === "bar") s.stack = "total";
    return s;
  });
  return clean({
    color: palette, title, tooltip: { trigger: "axis" }, legend: series.length > 1 ? { bottom: 0, type: "scroll" } : undefined,
    grid: { left: 48, right: 20, top: title ? 36 : 20, bottom: series.length > 1 ? 44 : 30, containLabel: true },
    xAxis: { type: "category", data: cats }, yAxis: { type: "value" }, series,
  });
}

// {nodes,edges|links} OR a tabular edge list {columns,rows: [source,target,weight?]}
// → an ECharts force-graph option.
function buildGraphOption(spec, opts) {
  opts = opts || {};
  const palette = opts.palette || VIZ_PALETTE;
  let nodes = [], links = [];
  if (spec && Array.isArray(spec.nodes)) {
    nodes = spec.nodes.map((n) => {
      if (typeof n === "string") return { name: n };
      if (n && typeof n === "object" && (n.name != null || n.id != null)) return clean({ name: String(n.name != null ? n.name : n.id), value: n.value, category: n.category });
      return null; // skip malformed nodes rather than emit a "undefined" node
    }).filter(Boolean);
    (spec.edges || spec.links || []).forEach((l) => {
      if (Array.isArray(l)) { if (l[0] != null && l[1] != null) links.push(clean({ source: String(l[0]), target: String(l[1]), value: l[2] })); }
      else if (l && l.source != null && l.target != null) links.push(clean({ source: String(l.source), target: String(l.target), value: l.value }));
    });
  } else if (spec && Array.isArray(spec.rows)) {
    const set = new Set();
    spec.rows.forEach((r) => { if (r[0] == null || r[1] == null) return; set.add(String(r[0])); set.add(String(r[1])); links.push(clean({ source: String(r[0]), target: String(r[1]), value: r[2] != null ? num(r[2]) : undefined })); });
    nodes = [...set].map((name) => ({ name }));
  }
  return {
    color: palette, tooltip: {},
    series: [{
      type: "graph", layout: opts.layout || "force", roam: true, draggable: true,
      label: { show: nodes.length <= 40, position: "right", fontSize: 11 },
      force: { repulsion: 200, edgeLength: 120, gravity: 0.08 },
      data: nodes, links,
      edgeSymbol: opts.directed ? ["none", "arrow"] : ["none", "none"],
      lineStyle: { color: "source", curveness: 0.06, opacity: 0.7 },
      emphasis: { focus: "adjacency" },
    }],
  };
}

// drop undefined keys so option objects are stable + clean to assert in tests
function clean(o) { Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]); return o; }

// top-level: a parsed viz spec → either inline HTML (table) or an ECharts option
// (chart/graph). dom.mjs decides how to mount each mode. Never throws.
function renderViz(spec, P, opts) {
  opts = opts || {};
  spec = spec || {}; // guaranteed not to throw, even on a null spec
  const type = String(spec.type || "").toLowerCase();
  try {
    if (type === "table") return { mode: "html", html: tableToHtml(normalizeTabular(parseData(spec.text, spec.format, P))) };
    if (type === "graph") {
      const v = parseData(spec.text, spec.format, P);
      const g = (v && (v.nodes || v.edges || v.links)) ? v : normalizeTabular(v);
      return { mode: "echarts", option: buildGraphOption(g, opts) };
    }
    if (type === "chart") {
      const v = parseData(spec.text, spec.format, P);
      if (spec.kind) return { mode: "echarts", option: buildChartOption(spec.kind, normalizeTabular(v), opts) };
      return { mode: "echarts", option: v }; // body is a full ECharts option
    }
    return { mode: "html", html: '<div class="viz-error">unknown viz type: ' + escapeHtml(type) + "</div>" };
  } catch (e) {
    return { mode: "html", html: '<div class="viz-error">viz error: ' + escapeHtml(String((e && e.message) || e)) + "</div>" };
  }
}

// runtime/dom — browser-coupled rendering + wiring. Concatenated after pure.mjs +
// viz.mjs + shared/escape.mjs by src/build-runtime.mjs into the single offline app.js.
// Doc bodies arrive PRE-RENDERED as sanitized HTML (wiki-links already resolved at
// build); the runtime mounts that HTML and HYDRATES the interactive widgets:
// `.viz` → ECharts (charts/graphs) or a sortable table, `.mermaid` → mermaid, SVG
// views → pan/zoom. Uses window/document; covered by the jsdom harness.

const STORY = window.STORY;
const docs = STORY.docs;
const docNames = Object.keys(docs);
// own-property test: doc ids are user titles, so a route like #/constructor must NOT match
// an inherited Object property (which would crash downstream).
const hasDoc = (k) => Object.prototype.hasOwnProperty.call(docs, k);

// home fallback: meta.home should resolve (build validates), else first doc (grill H5)
const HOME = hasDoc(nfc(STORY.meta.home)) ? nfc(STORY.meta.home) : docNames[0];

// route = #/<doc>[?h=<heading-slug>]. Returns the resolved doc name + heading anchor.
function parseRoute() {
  const rawHash = (location.hash || "").replace(/^#\/?/, "");
  const qi = rawHash.indexOf("?");
  const docPart = qi < 0 ? rawHash : rawHash.slice(0, qi);
  let name = HOME;
  try { const n = nfc(decodeURIComponent(docPart)); if (hasDoc(n)) name = n; } catch (e) { /* HOME */ }
  let anchor = "";
  if (qi >= 0) for (const kv of rawHash.slice(qi + 1).split("&")) { const i = kv.indexOf("="); if (i < 0) continue; if (kv.slice(0, i) === "h") { try { anchor = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* ignore */ } } }
  return { name, anchor };
}

function buildNav() {
  const nav = document.getElementById("nav");
  let html = "";
  STORY.groups.forEach((g) => {
    const items = docNames.filter((n) => docs[n].group === g.id);
    if (!items.length) return;
    html += '<div class="nav-group"><div class="nav-group__label">' + escapeHtml(g.label) + "</div>";
    items.forEach((n) => {
      html += '<a class="nav-item" data-doc="' + escapeAttr(n) + '" href="#/' + encodeURIComponent(n) +
        '"><span class="nav-item__icon">' + icon(docs[n].icon) + '</span><span class="nav-item__label">' + escapeHtml(n) + "</span></a>";
    });
    html += "</div>";
  });
  nav.innerHTML = html;
}

const BL_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7H6a3 3 0 0 0 0 6h2M12 7h2a3 3 0 0 1 0 6h-2M7.5 10h5"/></svg>';
function backlinkPanel(name) {
  // own-property + Array.isArray: backlinks is keyed by user title; never read an inherited
  // member (e.g. a doc literally named "constructor") or a non-array as the link list.
  const raw = STORY.backlinks && Object.prototype.hasOwnProperty.call(STORY.backlinks, name) ? STORY.backlinks[name] : null;
  const list = Array.isArray(raw) ? raw : [];
  let html = '<div class="backlinks"><div class="backlinks__head">' + BL_ICON + "Backlinks <span class=\"backlinks__count\">" + list.length + "</span></div>";
  if (!list.length) return html + '<div class="backlinks__empty">Nothing links here yet.</div></div>';
  html += '<div class="backlinks__list">';
  list.forEach((b) => {
    const ic = icon(hasDoc(b.source) ? docs[b.source].icon : "file");
    html += '<a class="backlink-card" href="#/' + encodeURIComponent(b.source) + '"><span class="backlink-card__icon">' + ic +
      '</span><span class="backlink-card__body"><span class="backlink-card__title">' + escapeHtml(b.source) +
      '</span><span class="backlink-card__ctx">' + escapeHtml(b.excerpt || "") + "</span></span></a>";
  });
  return html + "</div></div>";
}

let mmdCounter = 0;
function renderDoc(name) {
  const doc = docs[name];
  disposeCharts();
  const canvas = document.getElementById("canvas");
  const groupLabel = (STORY.groups.find((g) => g.id === doc.group) || {}).label || "";
  const crumb = '<div class="crumb"><a href="#/' + encodeURIComponent(HOME) + '">' + escapeHtml(STORY.meta.title) +
    '</a><span class="crumb__sep">/</span><span class="crumb__group">' + escapeHtml(groupLabel) +
    '</span><span class="crumb__sep">/</span><span class="crumb__cur">' + escapeHtml(name) + "</span></div>";
  if (doc.svg) {
    // build-generated trusted SVG (e.g. the graph view); labels pre-escaped at build.
    canvas.innerHTML = crumb + '<article class="doc">' + metaRow(doc.meta) + '<div class="graph-host"></div></article>';
    attachPanZoom(canvas.querySelector(".graph-host"), doc.svg);
  } else {
    // pre-rendered, sanitized HTML body; hydrate widgets after mount.
    canvas.innerHTML = crumb + '<article class="doc">' + metaRow(doc.meta) + '<div class="doc-body markdown">' + (doc.html || "") + "</div>" + backlinkPanel(name) + "</article>";
    hydrateViz(canvas);
    wireSortable(canvas);
    renderMermaid(canvas);
  }
  canvas.scrollTop = 0;
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("nav-item--active", el.getAttribute("data-doc") === name));
  document.title = name + " · " + STORY.meta.title;
}

// ── viz hydration (ECharts charts/graphs + sortable tables) ───────────────────
let vizCharts = [];
function disposeCharts() { vizCharts.forEach((c) => { try { c.dispose(); } catch (e) { /* ignore */ } }); vizCharts = []; }

function vizPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => (cs.getPropertyValue(n) || "").trim();
  const p = [v("--accent"), v("--accent-2"), v("--accent-3"), v("--accent-4")].filter(Boolean);
  return p.length ? p.concat(VIZ_PALETTE).slice(0, 8) : VIZ_PALETTE;
}
function vizParsers() {
  return {
    json: (s) => JSON.parse(s),
    yaml: (s) => (window.jsyaml ? window.jsyaml.load(s) : JSON.parse(s)),
    csv: (s) => window.Papa.parse(s, { header: true, skipEmptyLines: true, dynamicTyping: true }).data,
  };
}

function hydrateViz(scope) {
  const P = vizParsers(), palette = vizPalette();
  scope.querySelectorAll(".viz").forEach((el) => {
    const text = el.textContent || "";
    if (text.length > VIZ_MAX) { el.innerHTML = '<div class="viz-error">data too large to render (' + text.length + " chars, limit " + VIZ_MAX + ") — reduce the dataset</div>"; return; }
    const spec = {
      type: (el.getAttribute("data-type") || "chart").toLowerCase(),
      kind: el.getAttribute("data-kind") || "",
      format: el.getAttribute("data-format") || "auto",
      text,
    };
    const opts = {
      palette,
      title: el.getAttribute("data-title") || "",
      stack: el.hasAttribute("data-stack"),
      smooth: el.hasAttribute("data-smooth"),
      directed: el.hasAttribute("data-directed"),
      layout: el.getAttribute("data-layout") || "",
    };
    let res;
    try { res = renderViz(spec, P, opts); }
    catch (e) { el.innerHTML = '<div class="viz-error">viz error: ' + escapeHtml(String((e && e.message) || e)) + "</div>"; return; }

    if (res.mode === "html") { el.innerHTML = res.html; el.classList.add("viz--ready"); return; }

    // echarts (chart/graph)
    if (!window.echarts) { el.innerHTML = '<div class="viz-error">charts unavailable (echarts not loaded)</div>'; return; }
    el.textContent = ""; // drop the raw data text
    const host = document.createElement("div");
    host.className = "viz-chart";
    host.style.width = "100%";
    // clamp data-height to a sane range so malformed content can't create a giant render surface
    const reqH = parseInt(el.getAttribute("data-height"), 10);
    const h = Number.isFinite(reqH) ? Math.max(120, Math.min(2000, reqH)) : (spec.type === "graph" ? 440 : 320);
    host.style.height = h + "px";
    el.appendChild(host);
    el.classList.add("viz--ready");
    let chart;
    try {
      chart = window.echarts.init(host, null, { renderer: "svg" });
      const opt = res.option || {};
      if (!opt.textStyle) {
        const cs = getComputedStyle(document.documentElement);
        const cssv = (n, d) => ((cs.getPropertyValue(n) || "").trim() || d);
        // follow the theme so charts stay legible in dark themes (text uses --ink)
        opt.textStyle = { fontFamily: cssv("--sans", "sans-serif"), color: cssv("--ink-soft", cssv("--ink", "#333")) };
      }
      chart.setOption(opt);
      vizCharts.push(chart);
    } catch (e) {
      if (chart) try { chart.dispose(); } catch (_) { /* ignore */ }
      el.innerHTML = '<div class="viz-error">chart error: ' + escapeHtml(String((e && e.message) || e)) + "</div>";
    }
  });
}

// click/Enter on a wb-table header → stable sort by that column (numeric if .num)
function wireSortable(scope) {
  scope.querySelectorAll("table.wb-table").forEach((table) => {
    const tbody = table.querySelector("tbody");
    if (!tbody) return;
    table.querySelectorAll("th[data-col]").forEach((th) => {
      const run = () => sortBy(table, tbody, th);
      th.addEventListener("click", run);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
    });
  });
}
function sortBy(table, tbody, th) {
  const col = +th.getAttribute("data-col");
  const num = th.classList.contains("num");
  const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
  table.querySelectorAll("th[data-col]").forEach((h) => h.setAttribute("aria-sort", "none"));
  th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
  const rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
  rows.sort((a, b) => {
    const x = a.children[col] ? a.children[col].textContent : "";
    const y = b.children[col] ? b.children[col].textContent : "";
    if (num) return ((parseFloat(x) || 0) - (parseFloat(y) || 0)) * dir;
    return x.localeCompare(y) * dir;
  });
  rows.forEach((r) => tbody.appendChild(r));
}

// ── Mermaid + SVG pan/zoom (floating toolbar + drag + initial fit-to-viewport) ──
function pzIcon(inner) { return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>"; }
const PZ = {
  in: pzIcon('<line x1="10" y1="6" x2="10" y2="14"/><line x1="6" y1="10" x2="14" y2="10"/>'),
  out: pzIcon('<line x1="6" y1="10" x2="14" y2="10"/>'),
  reset: pzIcon('<path d="M15 7a5.5 5.5 0 1 0 .7 5"/><path d="M15 3.5V7h-3.5"/>'),
  left: pzIcon('<path d="M12 6l-4 4 4 4"/>'),
  right: pzIcon('<path d="M8 6l4 4-4 4"/>'),
  up: pzIcon('<path d="M6 12l4-4 4 4"/>'),
  down: pzIcon('<path d="M6 8l4 4 4-4"/>'),
  grip: '<svg viewBox="0 0 20 20" fill="currentColor" stroke="none"><circle cx="8" cy="6" r="1.1"/><circle cx="12" cy="6" r="1.1"/><circle cx="8" cy="10" r="1.1"/><circle cx="12" cy="10" r="1.1"/><circle cx="8" cy="14" r="1.1"/><circle cx="12" cy="14" r="1.1"/></svg>',
};
function attachPanZoom(host, svg) {
  host.classList.add("mmd-has-pz");
  host.innerHTML =
    '<div class="mmd-viewport"><div class="mmd-pan">' + svg + "</div></div>" +
    '<div class="mmd-tools">' +
    '<span class="mmd-tools__grip" title="drag toolbar">' + PZ.grip + "</span>" +
    '<button class="mmd-tool" data-a="in" title="zoom in">' + PZ.in + "</button>" +
    '<button class="mmd-tool" data-a="out" title="zoom out">' + PZ.out + "</button>" +
    '<button class="mmd-tool" data-a="reset" title="reset">' + PZ.reset + "</button>" +
    '<span class="mmd-tool__sep"></span>' +
    '<button class="mmd-tool" data-a="left" title="left">' + PZ.left + "</button>" +
    '<button class="mmd-tool" data-a="right" title="right">' + PZ.right + "</button>" +
    '<button class="mmd-tool" data-a="up" title="up">' + PZ.up + "</button>" +
    '<button class="mmd-tool" data-a="down" title="down">' + PZ.down + "</button>" +
    "</div>";
  const vp = host.querySelector(".mmd-viewport"), pan = host.querySelector(".mmd-pan");
  const svgEl = pan.querySelector("svg");
  if (svgEl) { svgEl.style.maxWidth = "100%"; svgEl.style.height = "auto"; }
  let s = 1, tx = 0, ty = 0, s0 = 1, tx0 = 0, ty0 = 0;
  const MIN = 0.4, MAX = 8, STEP = 1.25, NUDGE = 64;
  function apply() { pan.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")"; }
  function zoomAbout(cx, cy, k) { const ns = Math.max(MIN, Math.min(MAX, s * k)); if (ns === s) return; tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply(); }
  function ctr() { const r = vp.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }
  host.querySelector(".mmd-tools").addEventListener("click", (e) => {
    const b = e.target.closest(".mmd-tool"); if (!b) return;
    const a = b.dataset.a, c = ctr();
    if (a === "in") zoomAbout(c[0], c[1], STEP);
    else if (a === "out") zoomAbout(c[0], c[1], 1 / STEP);
    else if (a === "reset") { s = s0; tx = tx0; ty = ty0; apply(); }
    else if (a === "left") { tx += NUDGE; apply(); }
    else if (a === "right") { tx -= NUDGE; apply(); }
    else if (a === "up") { ty += NUDGE; apply(); }
    else if (a === "down") { ty -= NUDGE; apply(); }
  });
  const tools = host.querySelector(".mmd-tools"), grip = tools.querySelector(".mmd-tools__grip");
  let gdrag = false, gx = 0, gy = 0;
  grip.addEventListener("pointerdown", (e) => { e.preventDefault(); gdrag = true; const tr = tools.getBoundingClientRect(), hr = host.getBoundingClientRect(); tools.style.left = (tr.left - hr.left) + "px"; tools.style.top = (tr.top - hr.top) + "px"; tools.style.right = "auto"; tools.style.bottom = "auto"; gx = e.clientX; gy = e.clientY; try { grip.setPointerCapture(e.pointerId); } catch (_) { } });
  grip.addEventListener("pointermove", (e) => { if (!gdrag) return; const hr = host.getBoundingClientRect(), tr = tools.getBoundingClientRect(); let nl = parseFloat(tools.style.left) + (e.clientX - gx), nt = parseFloat(tools.style.top) + (e.clientY - gy); nl = Math.max(4, Math.min(hr.width - tr.width - 4, nl)); nt = Math.max(4, Math.min(hr.height - tr.height - 4, nt)); tools.style.left = nl + "px"; tools.style.top = nt + "px"; gx = e.clientX; gy = e.clientY; });
  function gend(e) { if (!gdrag) return; gdrag = false; try { grip.releasePointerCapture(e.pointerId); } catch (_) { } }
  grip.addEventListener("pointerup", gend); grip.addEventListener("pointercancel", gend);
  let drag = false, lx = 0, ly = 0;
  vp.addEventListener("pointerdown", (e) => { drag = true; lx = e.clientX; ly = e.clientY; vp.classList.add("is-grabbing"); try { vp.setPointerCapture(e.pointerId); } catch (_) { } });
  vp.addEventListener("pointermove", (e) => { if (!drag) return; tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); });
  function end(e) { if (!drag) return; drag = false; vp.classList.remove("is-grabbing"); try { vp.releasePointerCapture(e.pointerId); } catch (_) { } }
  vp.addEventListener("pointerup", end); vp.addEventListener("pointercancel", end);
  vp.addEventListener("wheel", (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAbout(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? STEP : 1 / STEP); }, { passive: false });
  apply();
  requestAnimationFrame(() => {
    const vw = vp.getBoundingClientRect().width, ph = pan.getBoundingClientRect().height || 320, maxH = Math.round(window.innerHeight * 0.82);
    if (ph > maxH) { s = maxH / ph; tx = (vw - vw * s) / 2; apply(); vp.style.height = maxH + "px"; }
    else { vp.style.height = ph + "px"; }
    s0 = s; tx0 = tx; ty0 = ty;
  });
}

const BASE_FONT = 16, THRESHOLD = 11, MMD_MAX = 20000; // cap diagram source so a giant graph can't freeze the UI
const VIZ_MAX = 200000; // cap viz/chart source text (datasets are larger than diagrams) so parsing can't hang the UI
// flowchart node palette from theme vars (dedicated --mmd-node-* override the base
// surface tokens), so diagrams follow the active theme instead of a fixed light fill.
function mermaidPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => ((cs.getPropertyValue(n) || "").trim() || d);
  return {
    fill: v("--mmd-node", v("--paper-2", "#efeae0")),
    stroke: v("--mmd-node-stroke", v("--line-strong", "#ddd6c8")),
    color: v("--mmd-node-text", v("--ink", "#22201b")),
    link: v("--mmd-edge", v("--faint", "#b8b0a0")),
  };
}
function renderMermaid(scope) {
  if (!window.mermaid) return;
  const palette = mermaidPalette();
  scope.querySelectorAll(".mermaid").forEach((el) => {
    const src = el.textContent || "";
    if (src.length > MMD_MAX) { el.innerHTML = '<pre class="mermaid-error">diagram too large to render (' + src.length + " chars, limit " + MMD_MAX + ") — split it into smaller diagrams</pre>"; return; }
    const code = injectStyle(src, palette);
    const id = "mmd-" + mmdCounter++;
    try {
      window.mermaid.render(id, code).then(({ svg }) => {
        if (!el.isConnected) return; // route changed away before render finished — element is stale
        attachPanZoom(el, svg);
        const s = el.querySelector("svg");
        const natural = (s && s.viewBox && s.viewBox.baseVal && s.viewBox.baseVal.width) || 0;
        const shown = s ? s.getBoundingClientRect().width : 0;
        if (natural && shown) {
          const eff = BASE_FONT * (shown / natural);
          if (eff < THRESHOLD) {
            const a = document.createElement("div");
            a.className = "mmd-alert mmd-alert--warn";
            a.innerHTML = "⚠ This diagram is too large - effective font size ~ <b>" + eff.toFixed(1) + "px</b> (limit " + THRESHOLD + "px). <b>split it</b>: extract a part into a sub-page and drill in via a [[wiki-link]]. ";
            el.insertAdjacentElement("afterend", a);
          }
        }
      }).catch((e) => { if (!el.isConnected) return; el.innerHTML = '<pre class="mermaid-error">diagram render failed: ' + escapeHtml(String((e && e.message) || e)) + "</pre>"; });
    } catch (e) { if (el.isConnected) el.innerHTML = '<pre class="mermaid-error">diagram render failed</pre>'; }
  });
}

function route() {
  const r = parseRoute();
  renderDoc(r.name);
  // scroll to a [[Note#heading]] target (heading ids are assigned at build). Scope the
  // lookup to the rendered doc so a heading id that collides with a shell id (nav/canvas)
  // scrolls the heading, not the chrome.
  if (r.anchor) requestAnimationFrame(() => {
    const canvas = document.getElementById("canvas");
    const sel = '[id="' + (window.CSS && CSS.escape ? CSS.escape(r.anchor) : r.anchor.replace(/["\\]/g, "\\$&")) + '"]';
    const el = canvas && canvas.querySelector(sel);
    if (el) el.scrollIntoView({ block: "start" });
  });
}
function init() {
  document.getElementById("brand-title").textContent = STORY.meta.title;
  document.getElementById("brand-sub").textContent = STORY.meta.subtitle || "";
  buildNav();
  if (window.mermaid) {
    const mmdBg = (getComputedStyle(document.documentElement).getPropertyValue("--mmd-bg") || "").trim() || "#fbfaf6";
    // securityLevel "strict" makes mermaid sanitize its own generated SVG (it bundles
    // DOMPurify) and htmlLabels:false keeps labels as plain SVG <text> — together they
    // close the runtime path where author diagram source could inject HTML, since the
    // mermaid SVG is inserted via innerHTML and never passes the build sanitizer.
    window.mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", theme: "base",
      themeVariables: { darkMode: false, background: mmdBg, fontSize: "16px" },
      flowchart: { curve: "basis", htmlLabels: false, padding: 14, useMaxWidth: true },
    });
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => vizCharts.forEach((c) => { try { c.resize(); } catch (e) { /* ignore */ } }));
  route();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
