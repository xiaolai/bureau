// Offline artifact check (plan F4 / M1 DoD metric 2): the BUILT dist opens with
// zero console errors and renders. Loads the real emitted content.js + app.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import { buildSite } from "../src/build.mjs";

const GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "golden");

test("offline: built artifact loads with 0 console errors, builds nav, renders home", () => {
  const out = mkdtempSync(join(tmpdir(), "wb-offline-"));
  buildSite({ root: GOLDEN_ROOT, outDir: out, now: "2026-06-09" });

  const dom = new JSDOM(readFileSync(join(out, "index.html"), "utf8"), { runScripts: "outside-only", url: "http://localhost/" });
  const { window } = dom;
  const errors = [];
  window.console.error = (...a) => errors.push(a.join(" "));
  window.atob = atob; window.btoa = btoa; window.unescape = unescape; window.escape = escape;
  // mermaid + echarts stubbed to avoid the heavy vendored libs (golden home uses neither)
  window.mermaid = { initialize() {}, render: () => Promise.resolve({ svg: "<svg></svg>" }) };
  window.echarts = { init: () => ({ setOption() {}, dispose() {}, resize() {} }) };

  // load the REAL emitted content + bundle
  window.eval(readFileSync(join(out, "lib", "content.js"), "utf8"));
  window.eval(readFileSync(join(out, "lib", "app.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  assert.deepEqual(errors, [], "console errors on load: " + errors.join(" | "));
  assert.ok(window.document.querySelectorAll(".nav-item").length > 0, "nav built (docs resolve)");
  assert.ok(window.document.getElementById("canvas").textContent.trim().length > 0, "home doc rendered");
  assert.ok([...window.document.querySelectorAll("a.wikilink")].some((a) => !a.classList.contains("wikilink--missing")), "a real wiki-link resolved");
});
