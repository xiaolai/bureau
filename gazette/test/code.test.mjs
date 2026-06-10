import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanCode, codeModel } from "../src/code/scan.mjs";
import { renderTreemapSvg } from "../src/code/treemap.mjs";
import { buildSite } from "../src/build.mjs";

function codeDir() {
  const root = mkdtempSync(join(tmpdir(), "wb-code-"));
  mkdirSync(join(root, "core"), { recursive: true });
  writeFileSync(join(root, "a.mjs"), 'import { b } from "./core/b.mjs";\nexport const a = 1;\n');
  writeFileSync(join(root, "core", "b.mjs"), 'import "lodash";\nexport const b = 2;\n'); // external import skipped
  return root;
}

test("scan: LOC per file + relative import edges (externals skipped)", () => {
  const s = scanCode({ dir: codeDir() });
  assert.equal(s.fileCount, 2);
  assert.ok(s.totalLoc >= 4);
  assert.deepEqual(s.edges, [{ source: "a.mjs", target: "core/b.mjs" }]); // ./core/b resolved; lodash skipped
});

test("scan: catches a side-effect import AND a later from-import (no regex skip)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-imp-"));
  writeFileSync(join(root, "a.mjs"), 'import "./side.mjs";\nimport { b } from "./b.mjs";\nconst x = import("./dyn.mjs");\n');
  writeFileSync(join(root, "side.mjs"), "export const s = 0;");
  writeFileSync(join(root, "b.mjs"), "export const b = 2;");
  writeFileSync(join(root, "dyn.mjs"), "export const d = 3;");
  const s = scanCode({ dir: root });
  const tgts = s.edges.filter((e) => e.source === "a.mjs").map((e) => e.target).sort();
  assert.deepEqual(tgts, ["b.mjs", "dyn.mjs", "side.mjs"]); // all three, incl. side-effect + dynamic
});

test("scan: codeModel groups by top-level dir; treemap escapes file labels", () => {
  const s = scanCode({ dir: codeDir() });
  const cm = codeModel(s);
  assert.equal(cm.nodes["core/b.mjs"].group, "core");
  assert.equal(cm.nodes["a.mjs"].group, "a.mjs"); // top segment of a root file is the file itself
  // hostile filename label is escaped
  const svg = renderTreemapSvg({ files: [{ path: "<img>.js", loc: 10, group: "x" }], totalLoc: 10 });
  assert.doesNotMatch(svg, /<img>/);
});

test("scan: nonexistent / empty dir → null", () => {
  assert.equal(scanCode({ dir: "/nonexistent-code-xyz" }), null);
});

function codeProject() {
  const cd = codeDir();
  const root = mkdtempSync(join(tmpdir(), "wb-codebuild-"));
  mkdirSync(join(root, "gazette"), { recursive: true });
  writeFileSync(join(root, "gazette", "_config.json"), JSON.stringify({ meta: { home: "A", code: { dir: cd } }, groups: [{ id: "g", label: "G" }] }));
  writeFileSync(join(root, "gazette", "a.html"), '<article data-group="g"><h1>A</h1>x</article>');
  return { root, cd };
}

test("build: meta.code.dir injects Code Module map + Dependencies views", () => {
  const { root } = codeProject();
  buildSite({ root, outDir: join(root, "dist"), now: "2026-06-09" });
  const content = readFileSync(join(root, "dist", "lib", "content.js"), "utf8");
  assert.match(content, /Code · Module map/);
  assert.match(content, /Code · Dependencies/);
});

test("incremental: a code-file change invalidates the cache (no stale code views)", () => {
  const { root, cd } = codeProject();
  const out = join(root, "dist");
  buildSite({ root, outDir: out, now: "2026-06-09" });
  assert.equal(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // docs unchanged → cached
  writeFileSync(join(cd, "a.mjs"), readFileSync(join(cd, "a.mjs"), "utf8") + "\n// changed\nexport const z = 9;\n");
  assert.notEqual(buildSite({ root, outDir: out, now: "2026-06-09" }).cached, true); // code changed → rebuild
});
