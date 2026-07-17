import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanCode, codeModel } from "../src/code/scan.mjs";
import { renderTreemapSvg } from "../src/code/treemap.mjs";
import { buildSite } from "../src/build.mjs";

function codeDir(t) {
  const root = mkdtempSync(join(tmpdir(), "wb-code-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "core"), { recursive: true });
  writeFileSync(join(root, "a.mjs"), 'import { b } from "./core/b.mjs";\nexport const a = 1;\n');
  writeFileSync(join(root, "core", "b.mjs"), 'import "lodash";\nexport const b = 2;\n'); // external import skipped
  return root;
}

test("scan: LOC per file + relative import edges (externals skipped)", (t) => {
  const s = scanCode({ dir: codeDir(t) });
  assert.equal(s.fileCount, 2);
  assert.ok(s.totalLoc >= 4);
  assert.deepEqual(s.edges, [{ source: "a.mjs", target: "core/b.mjs" }]); // ./core/b resolved; lodash skipped
});

test("scan: catches a side-effect import AND a later from-import (no regex skip)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-imp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.mjs"), 'import "./side.mjs";\nimport { b } from "./b.mjs";\nconst x = import("./dyn.mjs");\n');
  writeFileSync(join(root, "side.mjs"), "export const s = 0;");
  writeFileSync(join(root, "b.mjs"), "export const b = 2;");
  writeFileSync(join(root, "dyn.mjs"), "export const d = 3;");
  const s = scanCode({ dir: root });
  const tgts = s.edges.filter((e) => e.source === "a.mjs").map((e) => e.target).sort();
  assert.deepEqual(tgts, ["b.mjs", "dyn.mjs", "side.mjs"]); // all three, incl. side-effect + dynamic
});

test("scan: codeModel groups by top-level dir; treemap escapes file labels", (t) => {
  const s = scanCode({ dir: codeDir(t) });
  const cm = codeModel(s);
  assert.equal(cm.nodes["core/b.mjs"].group, "core");
  assert.equal(cm.nodes["a.mjs"].group, "a.mjs"); // top segment of a root file is the file itself
  // hostile filename label is escaped
  const svg = renderTreemapSvg({ files: [{ path: "<img>.js", loc: 10, group: "x" }], totalLoc: 10 });
  assert.doesNotMatch(svg, /<img>/);
});

test("scan: nonexistent / empty dir → null", (t) => {
  const base = mkdtempSync(join(tmpdir(), "wb-nodir-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // a guaranteed-absent child of a fresh temp dir (never a hard-coded host path that
  // could actually exist and make the test flaky)
  const absent = join(base, "definitely-absent-" + Math.random().toString(36).slice(2));
  assert.equal(scanCode({ dir: absent }), null); // path does not exist → null
  assert.equal(scanCode({ dir: base }), null);   // exists but holds no code files → null
});

function codeProject(t) {
  const cd = codeDir(t); // codeDir registers its own cleanup on t
  const root = mkdtempSync(join(tmpdir(), "wb-codebuild-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "gazette"), { recursive: true });
  writeFileSync(join(root, "gazette", "_config.json"), JSON.stringify({ meta: { home: "A", code: { dir: cd } }, groups: [{ id: "g", label: "G" }] }));
  writeFileSync(join(root, "gazette", "a.html"), '<article data-group="g"><h1>A</h1>x</article>');
  return { root, cd };
}

test("build: meta.code.dir injects Code Module map + Dependencies views", (t) => {
  const { root } = codeProject(t);
  buildSite({ root, outDir: join(root, "dist"), now: "2026-06-09" });
  const content = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  assert.match(content, /Code · Module map/);
  assert.match(content, /Code · Dependencies/);
});

test("incremental: a code-file change invalidates the cache (no stale code views)", (t) => {
  const { root, cd } = codeProject(t);
  const out = join(root, "dist");
  const aFile = join(cd, "a.mjs");
  buildSite({ root, outDir: out, now: "2026-06-09" });
  assert.equal(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // docs unchanged → cached

  // (1) a byte-GROWING edit is detected
  writeFileSync(aFile, readFileSync(aFile, "utf8") + "\n// changed\nexport const z = 9;\n");
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // code changed → rebuild
  assert.equal(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true);     // settle → cached again

  // (2) a SAME-SIZE edit must ALSO invalidate. Appending only ever changes the byte COUNT;
  // a size-only cache key would silently serve a stale code view here. Rewrite in place with
  // identical byte length (swap one digit) and a distinct mtime so the change is observable.
  const before = readFileSync(aFile, "utf8");
  const swapped = before.replace("export const z = 9;", "export const z = 8;");
  assert.notEqual(swapped, before, "the swap must actually change the bytes");
  assert.equal(Buffer.byteLength(swapped), Buffer.byteLength(before), "the rewrite must be the same byte length");
  writeFileSync(aFile, swapped);
  const future = new Date("2030-01-01T00:00:00Z");
  utimesSync(aFile, future, future); // advance mtime deterministically (defeats same-millisecond granularity)
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // same-size change → rebuild
});
