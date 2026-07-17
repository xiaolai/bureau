// Offline artifact check (plan F4 / M1 DoD metric 2): the BUILT dist opens with
// zero errors and renders. Loads the real emitted content.js + app.js at a file:// origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { JSDOM, VirtualConsole } from "jsdom";
import { buildSite } from "../src/build.mjs";

const GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "golden");

test("offline: built artifact loads with 0 errors, builds nav, renders home", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "wb-offline-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  buildSite({ root: GOLDEN_ROOT, outDir: out, now: "2026-06-09" });

  // Capture EVERY error channel, not just console.error: jsdom's own parse/exception errors
  // (jsdomError), window.onerror, and unhandled promise rejections all count as "the offline
  // artifact failed to load cleanly". console.error from the eval'd bundle routes here too.
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push("jsdomError: " + ((e && e.message) || e)));
  virtualConsole.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

  // Load at a file:// origin — the artifact ships as an offline file:// board, so exercise that
  // origin (not http://localhost) to catch file-origin / offline-only regressions.
  const indexUrl = pathToFileURL(join(out, "index.html")).href;
  const dom = new JSDOM(readFileSync(join(out, "index.html"), "utf8"), { runScripts: "outside-only", url: indexUrl, virtualConsole });
  const { window } = dom;
  window.addEventListener("error", (ev) => errors.push("window.onerror: " + ((ev.error && ev.error.message) || ev.message)));
  window.addEventListener("unhandledrejection", (ev) => errors.push("unhandledrejection: " + ((ev.reason && ev.reason.message) || ev.reason)));
  window.atob = atob; window.btoa = btoa; window.unescape = unescape; window.escape = escape;
  // mermaid + echarts stubbed to avoid the heavy vendored libs (golden home uses neither)
  window.mermaid = { initialize() {}, render: () => Promise.resolve({ svg: "<svg></svg>" }) };
  window.echarts = { init: () => ({ setOption() {}, dispose() {}, resize() {} }) };

  // load the REAL emitted content + bundle
  window.eval(readFileSync(join(out, "lib", "content.js"), "utf8"));
  window.eval(readFileSync(join(out, "lib", "app.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  // Let pending microtasks / async render promises settle before asserting — an async render
  // failure that rejects AFTER DOMContentLoaded would otherwise escape the assertions. Two
  // macrotask turns flush any queued microtask chains (e.g. a mermaid/echarts render promise).
  await new Promise((r) => window.setTimeout(r, 0));
  await new Promise((r) => window.setTimeout(r, 0));

  assert.deepEqual(errors, [], "error channels on load: " + errors.join(" | "));
  assert.ok(window.document.querySelectorAll(".nav-item").length > 0, "nav built (docs resolve)");
  assert.ok(window.document.getElementById("canvas").textContent.trim().length > 0, "home doc rendered");
  assert.ok([...window.document.querySelectorAll("a.wikilink")].some((a) => !a.classList.contains("wikilink--missing")), "a real wiki-link resolved");
});
