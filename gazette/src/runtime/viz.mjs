// runtime/viz — pure, lib-free data-viz core. Parsers are INJECTED (the browser
// passes the vendored globals JSON / js-yaml / PapaParse; Node tests pass the same
// npm libs), so every builder here is a pure function: unit-tested in Node AND
// concatenated into the offline app.js. No window/document and no echarts import —
// the chart/graph builders return plain ECharts *option objects*; echarts.setOption
// runs in dom.mjs. Bundled after escape.mjs + pure.mjs by src/build-runtime.mjs.
import { escapeHtml } from "../shared/escape.mjs";

// warm default palette (paper/ink/cinnabar family); dom.mjs overrides from CSS vars.
export const VIZ_PALETTE = ["#b5642f", "#3f6f5b", "#9a7b3f", "#6a5acd", "#a23b52", "#4a7fa5", "#8a8d3f", "#9c6b4f"];

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
export function detectFormat(text) {
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
export function parseMarkdownTable(text) {
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
export function parseData(text, format, P) {
  const f = (!format || format === "auto") ? detectFormat(text) : String(format).toLowerCase();
  if (f === "markdown" || f === "md") return parseMarkdownTable(text);
  if (f === "json") return P.json(text);
  if (f === "csv") return P.csv(text);
  return P.yaml(text);
}

// any parsed shape → { columns:string[], rows:any[][] }. Accepts {columns,rows},
// array-of-objects (CSV/JSON), array-of-arrays (first row = header), array of
// primitives, or a plain key→value object.
export function normalizeTabular(value) {
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
export function tableToHtml(tab) {
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
export function buildChartOption(kind, tab, opts) {
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
export function buildGraphOption(spec, opts) {
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
export function renderViz(spec, P, opts) {
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
