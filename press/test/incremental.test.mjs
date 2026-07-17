// M2: incremental input-hash short-circuit. Unchanged inputs ⇒ cached no-op; any
// change ⇒ rebuild; a rebuild is byte-identical to a fresh full build (determinism).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, appendFileSync, readFileSync, rmSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { buildSite } from "../src/build.mjs";

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "golden");

function project(t) {
  const root = mkdtempSync(join(tmpdir(), "wb-inc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(GOLDEN, "gazette"), join(root, "gazette"), { recursive: true });
  return root;
}

// Sorted relative paths of every emitted file (recursive).
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

// `.buildmeta.json` records the absolute outDir, so it differs between output locations;
// every other emitted file must be byte-identical.
const VOLATILE = new Set([".buildmeta.json"]);

function assertTreeByteIdentical(a, b) {
  const fa = manifest(a).filter((f) => !VOLATILE.has(f));
  const fb = manifest(b).filter((f) => !VOLATILE.has(f));
  assert.deepEqual(fa, fb, "the two builds emit a different set of files");
  assert.ok(fa.length >= 8, "expected a full artifact, got only " + fa.length + " files");
  for (const f of fa) {
    assert.ok(
      Buffer.compare(readFileSync(join(a, f)), readFileSync(join(b, f))) === 0,
      f + " is not byte-identical between the incremental rebuild and a fresh full build"
    );
  }
}

test("incremental: unchanged → cached; changed → rebuild", (t) => {
  const root = project(t);
  const out = join(root, "dist");
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // first: full
  assert.equal(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true);      // unchanged: skip
  appendFileSync(join(root, "gazette", "10-hero.html"), "\nmore prose\n");
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true);   // changed: rebuild
});

test("incremental: a changed `now` invalidates (staleness depends on it)", (t) => {
  const root = project(t);
  const out = join(root, "dist");
  buildSite({ root, outDir: out, now: "2026-06-09" });
  assert.notEqual(buildSite({ root, outDir: out, now: "2027-01-01" }).cached, true);
});

test("incremental: a mutated input rebuilds to a byte-identical fresh full build (determinism)", (t) => {
  const root = project(t);
  const a = join(root, "a"), b = join(root, "b");

  // full build, then MUTATE an input and rebuild through the incremental path (same outDir)
  buildSite({ root, outDir: a, now: "2026-06-09" });
  appendFileSync(join(root, "gazette", "10-hero.html"), "\nmore prose\n");
  const reb = buildSite({ root, outDir: a, now: "2026-06-09" });
  assert.notEqual(reb.cached, true, "a mutated input must invalidate the incremental cache and rebuild");

  // the incrementally-rebuilt dist must match a from-scratch forced build of the SAME
  // mutated input, across every emitted file — the rebuild path is neither stale nor divergent.
  buildSite({ root, outDir: b, now: "2026-06-09", force: true });
  assertTreeByteIdentical(a, b);
});
