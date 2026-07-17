// Browser-render E2E — the layer jsdom can't reach. Builds the example board with the SHIPPED
// bundle, then loads it in real headless Chromium (file://, offline, strict CSP) and asserts the
// board actually RENDERS and is interactive: 0 console/page errors, nav builds, routing works,
// mermaid draws SVG, echarts draws a chart surface, tables sort, anchors resolve. Skips cleanly if
// the Chromium binary isn't installed (run `npx playwright install chromium`).
//
// The interactive checks run as ONE ordered scenario (subtests) over a single scenario-local page
// so console-error accumulation is meaningful and self-contained — never a module-shared `page`
// that filtering/concurrency could scramble or a final "no errors" check that passes trivially
// when the setup navigations are filtered out.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const GZ = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium, available = true;
try { ({ chromium } = await import("playwright")); } catch { available = false; }

let browser, board;

before(async () => {
  if (!available) return;
  try { browser = await chromium.launch(); }
  catch (e) {
    // ONLY a missing browser binary counts as "unavailable" (→ clean skip). Any other launch
    // failure (bad config, sandbox/permission denial, corrupt install) is a real regression that
    // must NOT be swallowed — rethrow so the suite fails loudly instead of falsely skipping.
    const msg = String((e && e.message) || e);
    if (/Executable doesn't exist|playwright install/i.test(msg)) { available = false; return; }
    throw e;
  }
  board = mkdtempSync(join(tmpdir(), "gz-browser-"));
  // build the richest example with the SHIPPED bundle — exactly what bureau:inspect runs.
  execFileSync("node", [join(GZ, "bin", "gazette.mjs"), "build", "--dir", join(GZ, "examples", "gazette"), "--out", board], { stdio: "ignore" });
});
after(async () => {
  if (browser) await browser.close();
  if (board) rmSync(board, { recursive: true, force: true });
});

// In CI we MUST exercise the browser layer — a missing Chromium should FAIL, not silently skip
// (a green run would otherwise claim browser coverage it never ran). Set BUREAU_REQUIRE_BROWSER=1
// to enforce. Locally (flag unset) it still skips cleanly so `node --test` is friction-free.
const REQUIRE_BROWSER = !!process.env.BUREAU_REQUIRE_BROWSER;
const guard = (t) => {
  if (available) return true;
  if (REQUIRE_BROWSER) assert.fail("browser layer required (BUREAU_REQUIRE_BROWSER set) but Playwright/Chromium is unavailable — run `npx playwright install --with-deps chromium`");
  t.skip("Chromium not installed — run `npx playwright install chromium`");
  return false;
};

test("board renders offline and stays interactive (ordered scenario over one page)", async (t) => {
  if (!guard(t)) return;

  // scenario-local state — created here (not module-shared) so the ordered subtests below are the
  // ONLY thing that touches this page, and `consoleErrors` accumulates exactly across their run.
  const consoleErrors = [];
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  await page.goto(pathToFileURL(join(board, "index.html")).href, { waitUntil: "networkidle" });
  await page.waitForSelector(".nav-item", { timeout: 10000 });

  try {
    await t.test("board renders offline with ZERO console/page errors (strict CSP holds)", () => {
      assert.deepEqual(consoleErrors, [], "console errors:\n" + consoleErrors.join("\n"));
    });

    await t.test("nav sections + the home document render", async () => {
      assert.ok((await page.$$(".nav-item")).length > 0, "nav items present");
      const body = await page.textContent(".doc-body, .doc");
      assert.ok(body && body.trim().length > 0, "home doc body has content");
    });

    await t.test("clicking a wiki-link / nav item routes to another document", async () => {
      const beforeUrl = page.url();
      await page.click(".nav-item:not(.nav-item--active)");
      await page.waitForFunction((u) => location.hash && location.href !== u, beforeUrl, { timeout: 5000 });
      assert.notEqual(page.url(), beforeUrl, "route (hash) changed on navigation");
    });

    await t.test("mermaid renders to SVG", async () => {
      // navigate to a doc that has a mermaid diagram (cold-events → sequence diagrams)
      await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /sequence|timeline|cold/i.test(JSON.stringify(window.STORY.docs[d]))); if (k) location.hash = "#/" + encodeURIComponent(k); });
      const svg = await page.waitForSelector(".mermaid svg", { timeout: 15000 }).catch(() => null);
      assert.ok(svg, "a .mermaid block produced an <svg>");
    });

    await t.test("DOT graph renders to a hand-drawn SVG (Viz WASM compiles under the CSP)", async () => {
      // navigate to a doc carrying a .dot block (the overview has the pipeline digraph)
      await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /class="dot/.test(window.STORY.docs[d].html || "")); if (k) location.hash = "#/" + encodeURIComponent(k); });
      const svg = await page.waitForSelector(".dot svg", { timeout: 20000 }).catch(() => null);
      assert.ok(svg, "a .dot block produced an <svg> (Graphviz-in-WASM ran, so 'wasm-unsafe-eval' is sufficient)");
      // rough.js redraws every shape as a <path>; a plain graphviz box graph has none until roughened
      const roughPaths = await page.$$eval(".dot svg path", (ps) => ps.length);
      assert.ok(roughPaths > 0, "rough.js redrew the graph as hand-drawn paths");
    });

    await t.test("DOT hardening: author links scrubbed + malformed graph errors without crashing", async (st) => {
      // isolated fixture (does NOT touch the shared example board): a graph carrying URL= links
      // (scrub target) plus a syntactically broken graph (error path).
      const dir = mkdtempSync(join(tmpdir(), "gz-dotedge-"));
      st.after(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "_config.json"), JSON.stringify({ meta: { title: "Edge", home: "DotEdge" }, groups: [{ id: "overview", label: "Overview" }] }));
      writeFileSync(join(dir, "10-dotedge.html"),
        '<article data-title="DotEdge" data-group="overview" data-updated="2026-06-01"><h1>DotEdge</h1>' +
        '<div class="dot" id="d-url">digraph { a [URL="https://evil.example/x"]; a -> b [URL="https://evil.example/y"] }</div>' +
        '<div class="dot" id="d-bad">digraph { this is not valid dot syntax</div>' +
        "</article>");
      const out = mkdtempSync(join(tmpdir(), "gz-dotedge-out-"));
      st.after(() => rmSync(out, { recursive: true, force: true }));
      execFileSync("node", [join(GZ, "bin", "gazette.mjs"), "build", "--dir", dir, "--out", out], { stdio: "ignore" });
      const p2 = await browser.newPage();
      const errs = [];
      p2.on("pageerror", (e) => errs.push("pageerror: " + e.message));
      try {
        await p2.goto(pathToFileURL(join(out, "index.html")).href, { waitUntil: "networkidle" });
        await p2.evaluate(() => { location.hash = "#/" + encodeURIComponent("DotEdge"); });
        await p2.waitForSelector("#d-url svg", { timeout: 20000 });      // the valid graph rendered
        const links = await p2.$$eval("#d-url svg *", (els) => els.filter((e) => e.hasAttribute("href") || e.hasAttribute("xlink:href") || e.hasAttribute("target")).length);
        assert.equal(links, 0, "scrubSvg stripped every author link target from the rendered graph");
        const errored = await p2.$("#d-bad .dot-error");
        assert.ok(errored, "malformed DOT rendered an inline .dot-error, not a thrown exception");
        assert.deepEqual(errs, [], "no page errors from the malformed graph:\n" + errs.join("\n"));
      } finally {
        await p2.close();   // close on EVERY path — a failed assertion/timeout must not leak the page
      }
    });

    await t.test("diagram toolbar downloads a standalone SVG with theme vars inlined (blob download under CSP)", async () => {
      await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /class="dot/.test(window.STORY.docs[d].html || "")); if (k) location.hash = "#/" + encodeURIComponent(k); });
      await page.waitForSelector(".dot svg", { timeout: 20000 });      // DOT rendered (its text carries var(--sans))
      const btn = await page.waitForSelector('.dot .mmd-tool[data-a="download"]', { timeout: 5000 });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),           // proves blob download isn't blocked by the strict CSP
        btn.click({ force: true }),                                   // toolbar is hover-revealed (opacity:0)
      ]);
      assert.match(download.suggestedFilename(), /\.svg$/, "downloaded file is named *.svg");
      const body = readFileSync(await download.path(), "utf8");
      assert.ok(body.includes("<svg"), "download is an SVG document");
      assert.ok(!body.includes("var(--"), "every theme var() was inlined to a concrete value for standalone viewing");
      await download.delete().catch(() => {});
    });

    await t.test("echarts chart renders a real chart surface (svg marks), not just a ready table", async () => {
      // Navigate to a doc that actually carries a CHART viz (data-type="chart") — NOT a table or a
      // graph. `.viz--ready` alone is set on table renders too, so it can't prove a chart drew.
      const chartDoc = await page.evaluate(() => {
        const k = Object.keys(window.STORY.docs).find((d) => /data-type="chart"/.test(window.STORY.docs[d].html || ""));
        if (k) location.hash = "#/" + encodeURIComponent(k);
        return k || null;
      });
      assert.ok(chartDoc, 'a chart fixture (viz data-type="chart") exists in the example board');
      // echarts is mounted with the SVG renderer, so a chart's drawing surface is an <svg> inside
      // `.viz-chart` — a host class ONLY created on the echarts path (never on a table render).
      const surface = await page.waitForSelector('.viz[data-type="chart"] .viz-chart svg', { timeout: 15000 }).catch(() => null);
      assert.ok(surface, "the chart viz produced an echarts .viz-chart svg drawing surface");
      // and it drew real chart geometry (bars/marks), not an empty surface
      const marks = await page.$$eval('.viz[data-type="chart"] .viz-chart svg path, .viz[data-type="chart"] .viz-chart svg rect', (els) => els.length);
      assert.ok(marks > 0, "the chart drew real marks (paths/rects) into its svg surface");
    });

    await t.test("a sortable table responds to a header click", async (st) => {
      // navigate to a table-bearing doc so this check is self-contained (not reliant on a prior
      // subtest having left a table on the page).
      await page.evaluate(() => { const k = Object.keys(window.STORY.docs).find((d) => /data-type="table"/.test(window.STORY.docs[d].html || "")); if (k) location.hash = "#/" + encodeURIComponent(k); });
      await page.waitForSelector("table.wb-table", { timeout: 10000 }).catch(() => null);
      const th = await page.$("table.wb-table th[data-col]");
      if (!th) {
        if (REQUIRE_BROWSER) assert.fail("no sortable table on the loaded board — the table fixture is missing (BUREAU_REQUIRE_BROWSER set)");
        return st.skip("no sortable table on the loaded board");
      }
      await th.click();
      const sorted = await page.$$eval("table.wb-table th[data-col]", (ths) => ths.some((h) => (h.getAttribute("aria-sort") || "none") !== "none"));
      assert.ok(sorted, "a column became sorted (aria-sort set)");
    });

    await t.test("no console/page errors accumulated across navigation + mermaid + charts + table", () => {
      // The load-time check only proved the first paint clean; the interactions above (routing,
      // mermaid, echarts, sorting) could emit errors. Re-assert at the end so those are caught too.
      assert.deepEqual(consoleErrors, [], "console errors after interactions:\n" + consoleErrors.join("\n"));
    });
  } finally {
    await page.close();
  }
});
