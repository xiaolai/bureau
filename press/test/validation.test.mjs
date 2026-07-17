import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadCorpus } from "../src/core/model.mjs";
import { buildSite } from "../src/build.mjs";
import { doc } from "./helpers.mjs";

// build a throwaway docs dir; returns its path. Pass the test context `t` so the
// temp root is torn down centrally after the test (no per-test rmSync bookkeeping).
function corpus(files, config = { meta: { home: "" }, groups: [{ id: "g", label: "G" }] }, t) {
  const root = mkdtempSync(join(tmpdir(), "wb-val-"));
  if (t) t.after(() => rmSync(root, { recursive: true, force: true }));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify(config));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(docsDir, name), body);
  return { root, docsDir };
}

test("validation: missing title throws loudly (M6 — no silent skip)", (t) => {
  const { docsDir } = corpus({ "a.html": doc({ group: "g" }) }, undefined, t);
  assert.throws(() => loadCorpus({ docsDir }), /missing title/);
});

test("validation: NFC-duplicate titles throw (H3 — one identity rule)", (t) => {
  // "café" precomposed vs decomposed are byte-different but NFC-equal
  const { docsDir } = corpus({
    "a.html": doc({ title: "café", group: "g" }),
    "b.html": doc({ title: "café", group: "g" }),
  }, undefined, t);
  assert.throws(() => loadCorpus({ docsDir }), /duplicate title/);
});

test("validation: array/bracket title throws (M13)", (t) => {
  const { docsDir } = corpus({ "a.html": doc({ title: "[x, y]", group: "g" }) }, undefined, t);
  assert.throws(() => loadCorpus({ docsDir }), /invalid title/);
});

test("validation: meta.home pointing nowhere throws (H5 — prevents white-screen)", (t) => {
  const { docsDir } = corpus(
    { "a.html": doc({ title: "A", group: "g" }) },
    { meta: { home: "Ghost" }, groups: [{ id: "g", label: "G" }] },
    t
  );
  assert.throws(() => loadCorpus({ docsDir }), /meta\.home/);
});

test("validation: a real doc titled like a generated page throws — no silent clobber (C1)", (t) => {
  const { root, docsDir } = corpus(
    { "a.html": doc({ title: "Health", group: "g" }) },
    { meta: { home: "Health" }, groups: [{ id: "g", label: "G" }, { id: "health", label: "Health" }] },
    t
  );
  assert.throws(
    () => buildSite({ root, docsDir, outDir: join(root, "dist"), now: "2026-06-09" }),
    /generated-doc title collides with a real document/
  );
});

test("validation: --out at the project root is refused (M1)", (t) => {
  const { root, docsDir } = corpus({ "a.html": doc({ title: "A", group: "g" }) }, undefined, t);
  assert.throws(() => buildSite({ root, docsDir, outDir: root, now: "2026-06-09" }), /recursively delete/);
});

test("validation: a title containing | throws (wiki-link delimiter)", (t) => {
  const { docsDir } = corpus({ "a.html": doc({ title: "A|B", group: "g" }) }, undefined, t);
  assert.throws(() => loadCorpus({ docsDir }), /invalid title/);
});
