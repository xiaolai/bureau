import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import Papa from "papaparse";
import {
  detectFormat, parseData, normalizeTabular, tableToHtml,
  buildChartOption, buildGraphOption, renderViz, parseMarkdownTable,
} from "../src/runtime/viz.mjs";

// the same injected-parser bundle the browser builds from its vendored globals
const P = {
  json: (s) => JSON.parse(s),
  yaml: (s) => yaml.load(s),
  csv: (s) => Papa.parse(s, { header: true, skipEmptyLines: true, dynamicTyping: true }).data,
};

test("detectFormat: json vs markdown vs csv vs yaml", () => {
  assert.equal(detectFormat('{"a":1}'), "json");
  assert.equal(detectFormat("[1,2,3]"), "json");
  assert.equal(detectFormat("| a | b |\n|---|---|\n| 1 | 2 |"), "markdown");
  assert.equal(detectFormat("chapter,words\n1,3200\n2,4100"), "csv");
  assert.equal(detectFormat("type: bar\nkind: stacked"), "yaml");
  assert.equal(detectFormat(""), "json");
});

test("parseMarkdownTable: GFM table → columns/rows with numbers coerced", () => {
  const tab = parseMarkdownTable("| name | n |\n| --- | --- |\n| Lin | 3 |\n| Wei | 9 |");
  assert.deepEqual(tab.columns, ["name", "n"]);
  assert.deepEqual(tab.rows, [["Lin", 3], ["Wei", 9]]);
});

test("renderViz: a markdown-table chart/table input (the 4th input format)", () => {
  const md = "| chapter | words |\n|---|---|\n| 1 | 3200 |\n| 2 | 4100 |";
  const t = renderViz({ type: "table", format: "markdown", text: md }, P);
  assert.equal(t.mode, "html");
  assert.match(t.html, /chapter/);        // header rendered
  // assert the actual data cells, not just the header — dropping the rows must fail the test
  assert.match(t.html, /<td[^>]*>3200<\/td>/);
  assert.match(t.html, /<td[^>]*>4100<\/td>/);
  const c = renderViz({ type: "chart", kind: "bar", format: "auto", text: md }, P); // auto-detect markdown
  assert.equal(c.mode, "echarts");
  assert.deepEqual(c.option.series[0].data, [3200, 4100]);
});

test("parseData+normalizeTabular: CSV (real PapaParse) → columns/rows with typed numbers", () => {
  const tab = normalizeTabular(parseData("chapter,words\n1,3200\n2,4100", "csv", P));
  assert.deepEqual(tab.columns, ["chapter", "words"]);
  assert.deepEqual(tab.rows, [[1, 3200], [2, 4100]]);
});

test("parseData: YAML (real js-yaml) tabular array of maps", () => {
  const tab = normalizeTabular(parseData("- {label: Mon, value: 12}\n- {label: Tue, value: 19}", "yaml", P));
  assert.deepEqual(tab.columns, ["label", "value"]);
  assert.deepEqual(tab.rows, [["Mon", 12], ["Tue", 19]]);
});

test("normalizeTabular: array-of-arrays uses first row as header; primitives → 'value'", () => {
  assert.deepEqual(normalizeTabular([["a", "b"], [1, 2]]), { columns: ["a", "b"], rows: [[1, 2]] });
  assert.deepEqual(normalizeTabular([5, 6]), { columns: ["value"], rows: [[5], [6]] });
});

test("tableToHtml: numeric column right-aligned, hostile cell escaped (no XSS)", () => {
  const html = tableToHtml({ columns: ["name", "n"], rows: [["<img src=x onerror=alert(1)>", 3]] });
  assert.match(html, /<th data-col="1" class="num"/);     // numeric column flagged
  assert.match(html, /<td class="num">3<\/td>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("buildChartOption: bar maps first col→x axis, rest→series", () => {
  const o = buildChartOption("bar", { columns: ["chapter", "words"], rows: [[1, 3200], [2, 4100]] });
  assert.equal(o.xAxis.type, "category");
  assert.deepEqual(o.xAxis.data, ["1", "2"]);
  assert.equal(o.series.length, 1);
  assert.equal(o.series[0].type, "bar");
  assert.deepEqual(o.series[0].data, [3200, 4100]);
});

test("buildChartOption: line/area/pie/scatter shapes", () => {
  assert.equal(buildChartOption("line", { columns: ["x", "y"], rows: [[1, 2]] }).series[0].type, "line");
  assert.ok(buildChartOption("area", { columns: ["x", "y"], rows: [[1, 2]] }).series[0].areaStyle);
  const pie = buildChartOption("pie", { columns: ["name", "v"], rows: [["A", 3], ["B", 7]] });
  assert.equal(pie.series[0].type, "pie");
  assert.deepEqual(pie.series[0].data, [{ name: "A", value: 3 }, { name: "B", value: 7 }]);
  const sc = buildChartOption("scatter", { columns: ["x", "y"], rows: [[1, 2], [3, 4]] });
  assert.equal(sc.series[0].type, "scatter");
  assert.deepEqual(sc.series[0].data, [[1, 2], [3, 4]]);
});

test("buildChartOption: multi-series + stacked bar", () => {
  const o = buildChartOption("bar", { columns: ["q", "a", "b"], rows: [["Q1", 1, 2]] }, { stack: true });
  assert.equal(o.series.length, 2);
  assert.equal(o.series[0].stack, "total");
  assert.ok(o.legend); // >1 series → legend present
});

test("buildGraphOption: {nodes,edges} object", () => {
  const o = buildGraphOption({ nodes: ["A", "B", "C"], edges: [["A", "B"], ["B", "C"]] }, { directed: true });
  assert.equal(o.series[0].type, "graph");
  assert.equal(o.series[0].data.length, 3);
  assert.equal(o.series[0].links.length, 2);
  assert.deepEqual(o.series[0].edgeSymbol, ["none", "arrow"]);
});

test("buildGraphOption: tabular edge list infers node set", () => {
  const tab = normalizeTabular(parseData("source,target\nA,B\nB,C\nC,A", "csv", P));
  const o = buildGraphOption(tab);
  assert.equal(o.series[0].data.length, 3);  // A,B,C
  assert.equal(o.series[0].links.length, 3);
});

test("renderViz: table → html mode; chart → echarts mode; bad input never throws", () => {
  const t = renderViz({ type: "table", format: "csv", text: "a,b\n1,2" }, P);
  assert.equal(t.mode, "html");
  assert.match(t.html, /<table class="wb-table"/);
  const c = renderViz({ type: "chart", kind: "bar", format: "csv", text: "a,b\n1,2" }, P);
  assert.equal(c.mode, "echarts");
  assert.ok(Array.isArray(c.option.series));
  const g = renderViz({ type: "graph", format: "json", text: '{"nodes":["A","B"],"edges":[["A","B"]]}' }, P);
  assert.equal(g.option.series[0].data.length, 2);
  const bad = renderViz({ type: "chart", kind: "bar", format: "json", text: "{not json" }, P);
  assert.equal(bad.mode, "html");
  assert.match(bad.html, /viz error/);
});

test("renderViz: chart with no kind passes a full ECharts option straight through", () => {
  const spec = '{"series":[{"type":"gauge","data":[{"value":50}]}]}';
  const r = renderViz({ type: "chart", format: "json", text: spec }, P);
  assert.equal(r.option.series[0].type, "gauge");
});

test("renderViz: a null spec never throws", () => {
  const r = renderViz(null, P);
  assert.equal(r.mode, "html");
  assert.match(r.html, /unknown viz type/);
});

test("parseMarkdownTable: an escaped pipe stays inside the cell", () => {
  const tab = parseMarkdownTable("| a | b |\n|---|---|\n| x \\| y | 2 |");
  assert.deepEqual(tab.rows, [["x | y", 2]]);
});

test("normalizeTabular: a mixed array (object + null + primitive) does not throw", () => {
  const tab = normalizeTabular([{ a: 1, b: 2 }, null, { a: 3 }]);
  assert.deepEqual(tab.columns, ["a", "b"]);
  assert.deepEqual(tab.rows, [[1, 2], ["", ""], [3, ""]]);
});
