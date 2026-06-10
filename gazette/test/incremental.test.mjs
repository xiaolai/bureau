// M2: incremental input-hash short-circuit. Unchanged inputs ⇒ cached no-op; any
// change ⇒ rebuild; a rebuild is byte-identical to a fresh full build (determinism).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, appendFileSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { buildSite } from "../src/build.mjs";

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "golden");

function project() {
  const root = mkdtempSync(join(tmpdir(), "wb-inc-"));
  cpSync(join(GOLDEN, "gazette"), join(root, "gazette"), { recursive: true });
  return root;
}

test("incremental: unchanged → cached; changed → rebuild", () => {
  const root = project();
  const out = join(root, "dist");
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // first: full
  assert.equal(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true);      // unchanged: skip
  appendFileSync(join(root, "gazette", "10-hero.html"), "\nmore prose\n");
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true);   // changed: rebuild
});

test("incremental: a changed `now` invalidates (staleness depends on it)", () => {
  const root = project();
  const out = join(root, "dist");
  buildSite({ root, outDir: out, now: "2026-06-09" });
  assert.notEqual(buildSite({ root, outDir: out, now: "2027-01-01" }).cached, true);
});

test("incremental: a rebuild is byte-identical to a fresh full build (determinism)", () => {
  const root = project();
  buildSite({ root, outDir: join(root, "a"), now: "2026-06-09" });
  buildSite({ root, outDir: join(root, "b"), now: "2026-06-09", force: true });
  for (const f of ["model.json", "health.json", "graph.json", "lib/content.js"]) {
    assert.equal(readFileSync(join(root, "a", f), "utf8"), readFileSync(join(root, "b", f), "utf8"), f);
  }
});
