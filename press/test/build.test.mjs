import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { FIXED_NOW } from "./helpers.mjs";
import { buildSite } from "../src/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_ROOT = resolve(here, "..", "examples", "golden");

function buildTo(dir) {
  return buildSite({ root: GOLDEN_ROOT, outDir: dir, now: FIXED_NOW });
}

test("buildSite: integrated build emits deterministic model.json + health.json", () => {
  const a = mkdtempSync(join(tmpdir(), "wb-a-"));
  const b = mkdtempSync(join(tmpdir(), "wb-b-"));
  const ra = buildTo(a);
  const rb = buildTo(b);

  // health wired through the integrated path
  assert.deepEqual(ra.health, { dangling: 1, orphan: 1, contradiction: 1, invalidDate: 0, stale: 1, schema: 1, drift: 0, unsourced: 0 });
  assert.equal(ra.healthClean, false);

  // double-build byte-identical across the WHOLE artifact (the determinism gate, P3 / grill M11)
  for (const f of ["model.json", "health.json", "lib/content.js", "index.html"]) {
    assert.equal(readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8"), f + " not deterministic");
  }

  // health view is injected as a board doc, and the artifact is self-contained
  const content = readFileSync(join(a, "lib", "content.js"), "utf8");
  assert.match(content, /Health/);

  // the CSP actually ships in the artifact (grill H2 — not just in a dead helper)
  const html = readFileSync(join(a, "index.html"), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  // and no remote origins remain (grill M4 — truly offline)
  assert.doesNotMatch(html, /https?:\/\//);

  assert.equal(ra.outDir, a);
  void rb;
});

test("theme: dist :root is generated from tokens; theme.json recolors it (DoD)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-theme-"));
  cpSync(join(GOLDEN_ROOT, "gazette"), join(root, "gazette"), { recursive: true });
  writeFileSync(join(root, "theme.json"), JSON.stringify({ accent: "#123456" }));
  buildSite({ root, outDir: join(root, "dist"), now: FIXED_NOW });
  const css = readFileSync(join(root, "dist", "lib", "theme.css"), "utf8");
  assert.match(css, /:root\s*\{/, "generated :root present");
  assert.match(css, /--accent:\s*#123456/, "theme.json token override applied");
  assert.match(css, /--paper:\s*#f9f7f2/, "un-overridden tokens keep defaults");
});
