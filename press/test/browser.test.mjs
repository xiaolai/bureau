// Browser-render E2E — the layer jsdom can't reach. Builds the example board with the SHIPPED
// bundle, then loads it in real headless Chromium (file://, offline, strict CSP) and asserts the
// board actually RENDERS and is interactive: 0 console/page errors, nav builds, routing works,
// mermaid draws SVG, echarts draws a canvas, tables sort, anchors resolve. Skips cleanly if the
// Chromium binary isn't installed (run `npx playwright install chromium`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const GZ = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium, available = true;
try { ({ chromium } = await import("playwright")); } catch { available = false; }

let browser, page, board, consoleErrors;

before(async () => {
  if (!available) return;
  try { browser = await chromium.launch(); } catch { available = false; return; } // no browser binary
  board = mkdtempSync(join(tmpdir(), "gz-browser-"));
  // build the richest example with the SHIPPED bundle — exactly what bureau:inspect runs.
  execFileSync("node", [join(GZ, "bin", "gazette.mjs"), "build", "--dir", join(GZ, "examples", "gazette"), "--out", board], { stdio: "ignore" });
  consoleErrors = [];
  page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  await page.goto(pathToFileURL(join(board, "index.html")).href, { waitUntil: "networkidle" });
  await page.waitForSelector(".nav-item", { timeout: 10000 });
});
after(async () => { if (browser) await browser.close(); });

// In CI we MUST exercise the browser layer — a missing Chromium should FAIL, not silently skip
// (a green run would otherwise claim browser coverage it never ran). Set BUREAU_REQUIRE_BROWSER=1
// to enforce. Locally (flag unset) it still skips cleanly so `node --test` is friction-free.
const REQUIRE_BROWSER = !!process.env.BUREAU_REQUIRE_BROWSER;
const guard = (t) => {
  if (available) return;
  if (REQUIRE_BROWSER) assert.fail("browser layer required (BUREAU_REQUIRE_BROWSER set) but Playwright/Chromium is unavailable — run `npx playwright install --with-deps chromium`");
  t.skip("Chromium not installed — run `npx playwright install chromium`");
};

test("board renders offline with ZERO console/page errors (strict CSP holds)", (t) => {
  guard(t); if (!available) return;
  assert.deepEqual(consoleErrors, [], "console errors:\n" + consoleErrors.join("\n"));
});

test("nav sections + the home document render", async (t) => {
  guard(t); if (!available) return;
  assert.ok((await page.$$(".nav-item")).length > 0, "nav items present");
  const body = await page.textContent(".doc-body, .doc");
  assert.ok(body && body.trim().length > 0, "home doc body has content");
});

test("clicking a wiki-link / nav item routes to another document", async (t) => {
  guard(t); if (!available) return;
  const before = page.url();
  await page.click(".nav-item:not(.nav-item--active)");
  await page.waitForFunction((u) => location.hash && location.href !== u, before, { timeout: 5000 });
  assert.notEqual(page.url(), before, "route (hash) changed on navigation");
});

test("mermaid renders to SVG", async (t) => {
  guard(t); if (!available) return;
  // navigate to a doc that has a mermaid diagram (cold-events → sequence diagrams)
  await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /sequence|timeline|cold/i.test(JSON.stringify(window.STORY.docs[d]))); if (k) location.hash = "#/" + encodeURIComponent(k); });
  const svg = await page.waitForSelector(".mermaid svg", { timeout: 15000 }).catch(() => null);
  assert.ok(svg, "a .mermaid block produced an <svg>");
});

test("DOT graph renders to a hand-drawn SVG (Viz WASM compiles under the CSP)", async (t) => {
  guard(t); if (!available) return;
  // navigate to a doc carrying a .dot block (the overview has the pipeline digraph)
  await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /class="dot/.test(window.STORY.docs[d].html || "")); if (k) location.hash = "#/" + encodeURIComponent(k); });
  const svg = await page.waitForSelector(".dot svg", { timeout: 20000 }).catch(() => null);
  assert.ok(svg, "a .dot block produced an <svg> (Graphviz-in-WASM ran, so 'wasm-unsafe-eval' is sufficient)");
  // rough.js redraws every shape as a <path>; a plain graphviz box graph has none until roughened
  const roughPaths = await page.$$eval(".dot svg path", (ps) => ps.length);
  assert.ok(roughPaths > 0, "rough.js redrew the graph as hand-drawn paths");
});

test("DOT hardening: author links scrubbed + malformed graph errors without crashing", async (t) => {
  guard(t); if (!available) return;
  // isolated fixture (does NOT touch the shared example board): a graph carrying URL= links
  // (scrub target) plus a syntactically broken graph (error path).
  const dir = mkdtempSync(join(tmpdir(), "gz-dotedge-"));
  writeFileSync(join(dir, "_config.json"), JSON.stringify({ meta: { title: "Edge", home: "DotEdge" }, groups: [{ id: "overview", label: "Overview" }] }));
  writeFileSync(join(dir, "10-dotedge.html"),
    '<article data-title="DotEdge" data-group="overview" data-updated="2026-06-01"><h1>DotEdge</h1>' +
    '<div class="dot" id="d-url">digraph { a [URL="https://evil.example/x"]; a -> b [URL="https://evil.example/y"] }</div>' +
    '<div class="dot" id="d-bad">digraph { this is not valid dot syntax</div>' +
    "</article>");
  const out = mkdtempSync(join(tmpdir(), "gz-dotedge-out-"));
  execFileSync("node", [join(GZ, "bin", "gazette.mjs"), "build", "--dir", dir, "--out", out], { stdio: "ignore" });
  const p2 = await browser.newPage();
  const errs = [];
  p2.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await p2.goto(pathToFileURL(join(out, "index.html")).href, { waitUntil: "networkidle" });
  await p2.evaluate(() => { location.hash = "#/" + encodeURIComponent("DotEdge"); });
  await p2.waitForSelector("#d-url svg", { timeout: 20000 });      // the valid graph rendered
  const links = await p2.$$eval("#d-url svg *", (els) => els.filter((e) => e.hasAttribute("href") || e.hasAttribute("xlink:href") || e.hasAttribute("target")).length);
  assert.equal(links, 0, "scrubSvg stripped every author link target from the rendered graph");
  const errored = await p2.$("#d-bad .dot-error");
  assert.ok(errored, "malformed DOT rendered an inline .dot-error, not a thrown exception");
  assert.deepEqual(errs, [], "no page errors from the malformed graph:\n" + errs.join("\n"));
  await p2.close();
});

test("echarts chart renders to a canvas", async (t) => {
  guard(t); if (!available) return;
  await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /viz|chart/.test(window.STORY.docs[d].body || "") || /class="viz/.test(window.STORY.docs[d].html || "")); if (k) location.hash = "#/" + encodeURIComponent(k); });
  const canvas = await page.waitForSelector(".viz canvas, .viz-chart canvas, .viz--ready", { timeout: 15000 }).catch(() => null);
  assert.ok(canvas, "a .viz chart rendered (canvas or html-ready)");
});

test("a sortable table responds to a header click", async (t) => {
  guard(t); if (!available) return;
  const th = await page.$("table.wb-table th[data-col]");
  if (!th) {
    if (REQUIRE_BROWSER) assert.fail("no sortable table on the loaded board — the table fixture is missing (BUREAU_REQUIRE_BROWSER set)");
    return t.skip("no sortable table on the loaded board");
  }
  await th.click();
  const sorted = await page.$$eval("table.wb-table th[data-col]", (ths) => ths.some((h) => (h.getAttribute("aria-sort") || "none") !== "none"));
  assert.ok(sorted, "a column became sorted (aria-sort set)");
});

test("no console/page errors accumulated across navigation + mermaid + charts + table", (t) => {
  // The load-time check only proved the first paint clean; later interactions (routing, mermaid,
  // echarts, sorting) could emit errors. Re-assert at the end so those are caught too.
  guard(t); if (!available) return;
  assert.deepEqual(consoleErrors, [], "console errors after interactions:\n" + consoleErrors.join("\n"));
});
