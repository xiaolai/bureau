// End-to-end: a real artifact drift driven through the whole buildSite pipeline → the Engine view on
// the Health page shows it, and the per-page chip data ships with the drifted page. Guards the wiring
// (build.mjs → liveArtifacts → renderHealthHtml + the shipped meta), not just the units.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSite } from "../src/build.mjs";
import { recordVerification } from "../src/engine/ledgers.mjs";

// concatenate every emitted text file — robust to which output file carries the Health HTML / meta data
function readTree(dir) {
  let blob = "";
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else { try { blob += readFileSync(p, "utf8"); } catch { /* binary */ } } } };
  walk(dir);
  return blob;
}

test("build: a drifted verified artifact surfaces in the Health Engine view and on the page's meta", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-build-arts-"));
  try {
    const canon = join(root, "canon");
    mkdirSync(canon, { recursive: true });
    // two mutually-linked pages so the graph is connected; content is irrelevant to the artifact check
    writeFileSync(join(canon, "u.md"), "---\nid: U\ntitle: Upstream\nstatus: canonical\n---\n# Upstream\nsee [[Downstream]] ^u\n");
    writeFileSync(join(canon, "d.md"), "---\nid: D\ntitle: Downstream\nstatus: proposed\n---\n# Downstream\nsee [[Upstream]] ^d\n");
    // an artifact the Upstream claim was verified against — then changed underneath it
    writeFileSync(join(root, "src.txt"), "original");
    recordVerification(canon, { root, page: "Upstream", artifact: "src.txt", date: "2026-07-18" });
    writeFileSync(join(root, "src.txt"), "CHANGED underneath the claim");

    const out = join(root, "board");
    buildSite({ root, docsDir: "canon", outDir: out, now: "2026-07-18" });
    const blob = readTree(out);

    // the Health page's Engine view (server-rendered)
    assert.match(blob, /Artifacts · currency/);
    assert.match(blob, /DRIFTED/);
    // the per-page chip DATA shipped with Upstream (rendered client-side by metaRow)
    assert.match(blob, /"artifacts":\s*\{[^}]*"drifted":\s*1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("build: editing a verified file busts the incremental cache — CURRENT → DRIFTED (fix #3)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-build-cache-"));
  try {
    const canon = join(root, "canon");
    mkdirSync(canon, { recursive: true });
    writeFileSync(join(canon, "u.md"), "---\nid: U\ntitle: Upstream\nstatus: canonical\n---\n# Upstream\nsee [[Downstream]] ^u\n");
    writeFileSync(join(canon, "d.md"), "---\nid: D\ntitle: Downstream\nstatus: proposed\n---\n# Downstream\nsee [[Upstream]] ^d\n");
    writeFileSync(join(root, "src.txt"), "original");
    recordVerification(canon, { root, page: "Upstream", artifact: "src.txt", date: "2026-07-18" });

    const out = join(root, "board");
    const r1 = buildSite({ root, docsDir: "canon", outDir: out, now: "2026-07-18" }); // artifact current
    assert.doesNotMatch(readTree(out), /DRIFTED/); // first board: nothing drifted
    assert.notEqual(r1.cached, true);

    // change the verified file OUT of band, then rebuild to the SAME outDir
    writeFileSync(join(root, "src.txt"), "CHANGED after the first build");
    const r2 = buildSite({ root, docsDir: "canon", outDir: out, now: "2026-07-18" });
    assert.notEqual(r2.cached, true, "a changed ledger artifact must invalidate the cache, not short-circuit");
    assert.match(readTree(out), /DRIFTED/, "the rebuilt board reflects the drift"); // not the stale CURRENT board
  } finally { rmSync(root, { recursive: true, force: true }); }
});
