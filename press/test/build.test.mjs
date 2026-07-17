import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { FIXED_NOW } from "./helpers.mjs";
import { buildSite } from "../src/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_ROOT = resolve(here, "..", "examples", "golden");

function buildTo(dir) {
  return buildSite({ root: GOLDEN_ROOT, outDir: dir, now: FIXED_NOW });
}

// Sorted relative paths of every file the build emitted (recursive).
function manifest(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

// `.buildmeta.json` records the absolute outDir, so it legitimately differs between two
// output locations. Every OTHER emitted file must be byte-identical — that is the whole
// determinism gate, not a hand-picked handful of files.
const VOLATILE = new Set([".buildmeta.json"]);

function assertTreeByteIdentical(a, b) {
  const fa = manifest(a).filter((f) => !VOLATILE.has(f));
  const fb = manifest(b).filter((f) => !VOLATILE.has(f));
  assert.deepEqual(fa, fb, "the two builds emit a different set of files");
  // sanity floor: a real artifact ships model/health/content/index/theme + the bundled libs.
  assert.ok(fa.length >= 8, "expected a full artifact, got only " + fa.length + " files");
  for (const f of fa) {
    assert.ok(
      Buffer.compare(readFileSync(join(a, f)), readFileSync(join(b, f))) === 0,
      f + " is not byte-identical across a double build (non-deterministic)"
    );
  }
}

// The ONLY absolute URLs allowed in a self-contained artifact are XML namespace URIs in
// generated SVG (e.g. http://www.w3.org/2000/svg) — declarative, never fetched. Any other
// remote origin breaks true-offline use (grill M4). We scan the text artifacts the build
// GENERATES from content; the vendored libs (lib/*.min.js, app.js) are pinned dependencies
// that legitimately carry URLs in license/comment text and are not derived from content.
const XML_NS = /https?:\/\/(?:www\.)?w3\.org\/[^\s"'`)<>\\]*/g;
function assertNoRemoteOrigin(text, label) {
  assert.doesNotMatch(text.replace(XML_NS, ""), /https?:\/\//, label + " references a remote origin — not offline");
}

test("buildSite: integrated build emits deterministic model.json + health.json", (t) => {
  const a = mkdtempSync(join(tmpdir(), "wb-a-"));
  const b = mkdtempSync(join(tmpdir(), "wb-b-"));
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  const ra = buildTo(a);
  const rb = buildTo(b);

  // health wired through the integrated path
  assert.deepEqual(ra.health, { dangling: 1, orphan: 1, contradiction: 1, invalidDate: 0, stale: 1, schema: 1, drift: 0, unsourced: 0 });
  assert.equal(ra.healthClean, false);

  // double-build byte-identical across the WHOLE artifact — every emitted file, not a
  // hand-picked few (the determinism gate, P3 / grill M11). content.js, index.html,
  // lib/theme.css and the bundled libs are all covered here.
  assertTreeByteIdentical(a, b);

  // health view is injected as a board doc, and the artifact is self-contained
  const content = readFileSync(join(a, "lib", "content.js"), "utf8");
  assert.match(content, /Health/);

  // the CSP actually ships in the artifact (grill H2 — not just in a dead helper)
  const html = readFileSync(join(a, "index.html"), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);

  // and no remote origin remains in ANY generated text artifact (grill M4 — truly offline).
  // A remote URL smuggled into content.js or theme.css would slip past an index.html-only scan.
  for (const f of ["index.html", "lib/content.js", "lib/theme.css", "model.json", "health.json", "graph.json"]) {
    assertNoRemoteOrigin(readFileSync(join(a, f), "utf8"), f);
  }

  assert.equal(ra.outDir, a);
  assert.equal(rb.outDir, b); // second build ran through the same integrated path
});

test("theme: dist :root is generated from tokens; theme.json recolors it (DoD)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-theme-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(GOLDEN_ROOT, "gazette"), join(root, "gazette"), { recursive: true });
  writeFileSync(join(root, "theme.json"), JSON.stringify({ accent: "#123456" }));
  buildSite({ root, outDir: join(root, "dist"), now: FIXED_NOW });
  const css = readFileSync(join(root, "dist", "lib", "theme.css"), "utf8");
  assert.match(css, /:root\s*\{/, "generated :root present");
  assert.match(css, /--accent:\s*#123456/, "theme.json token override applied");
  assert.match(css, /--paper:\s*#f9f7f2/, "un-overridden tokens keep defaults");
});

test("build: a doc linking a generated page ([[Health]]/[[Graph]]) is not falsely dangling", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-known-"));
  const out = mkdtempSync(join(tmpdir(), "wb-known-out-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
  const gz = join(root, "gazette");
  cpSync(join(GOLDEN_ROOT, "gazette"), gz, { recursive: true });
  // a real doc that links the generated Health + Graph pages by title
  writeFileSync(join(gz, "99-links-generated.html"), '<article data-group="meta"><h1>Meta</h1><p>see [[Health]] and [[Graph]]</p></article>');
  const r = buildSite({ root, outDir: out, now: FIXED_NOW });
  // those links resolve to generated docs, so they must NOT inflate the dangling count
  const health = JSON.parse(readFileSync(join(out, "health.json"), "utf8"));
  const danglingToGenerated = health.dangling.filter((d) => d.target === "Health" || d.target === "Graph");
  assert.deepEqual(danglingToGenerated, [], "links to generated pages must not be dangling");
});
