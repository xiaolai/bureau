// Artifact currency for the board (ADR-0001, §4.16) — the _verify.json ledger re-hashed against the
// working tree so the gazette can show a claim whose verified file DRIFTED. Drives the real ledger
// (recordVerification) so the fingerprints are genuine, then projects the board view from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { recordVerification } from "../src/engine/ledgers.mjs";
import { liveArtifacts } from "../src/engine/artifacts.mjs";

// a repo with a canon workspace + real files at the repo root (the artifacts a claim is checked against)
function repo(files, artifacts) {
  const root = mkdtempSync(join(tmpdir(), "wb-arts-"));
  const dir = join(root, "canon");
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  for (const [k, v] of Object.entries(artifacts || {})) writeFileSync(join(root, k), v);
  return { root, dir, write: (rel, body) => writeFileSync(join(root, rel), body), rm: (rel) => rmSync(join(root, rel)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const view = (r) => { const corpus = loadCorpus({ docsDir: r.dir }); return liveArtifacts({ workspaceDir: r.dir, root: r.root, corpus, model: buildModel({ corpus }) }); };
const UP = "---\nid: U\ntitle: Upstream\n---\n# Upstream\nx\n";

test("artifacts: an unchanged fingerprinted file is current (chip on the page, no drift)", () => {
  const r = repo({ "u.md": UP }, { "src.txt": "hello" });
  try {
    recordVerification(r.dir, { root: r.root, page: "Upstream", artifact: "src.txt", date: "2026-07-18" });
    const a = view(r);
    assert.equal(a.counts.current, 1);
    assert.equal(a.counts.drifted, 0);
    assert.equal(a.byKey.size, 1);
    assert.deepEqual([...a.byKey.values()][0], { current: 1, drifted: 0 });
  } finally { r.cleanup(); }
});

test("artifacts: editing the verified file drifts it (row + count + page chip flips)", () => {
  const r = repo({ "u.md": UP }, { "src.txt": "hello" });
  try {
    recordVerification(r.dir, { root: r.root, page: "Upstream", artifact: "src.txt", date: "2026-07-18" });
    r.write("src.txt", "CHANGED underneath the claim");
    const a = view(r);
    assert.equal(a.counts.drifted, 1);
    assert.equal(a.drift.length, 1);
    assert.equal(a.drift[0].page, "Upstream");
    assert.equal(a.drift[0].artifact, "src.txt");
    assert.notEqual(a.drift[0].now, null); // the file still exists — its hash simply changed
    assert.deepEqual([...a.byKey.values()][0], { current: 0, drifted: 1 });
  } finally { r.cleanup(); }
});

test("artifacts: a deleted artifact drifts with now:null (file missing)", () => {
  const r = repo({ "u.md": UP }, { "src.txt": "hello" });
  try {
    recordVerification(r.dir, { root: r.root, page: "Upstream", artifact: "src.txt", date: "2026-07-18" });
    r.rm("src.txt");
    const a = view(r);
    assert.equal(a.counts.drifted, 1);
    assert.equal(a.drift[0].now, null);
  } finally { r.cleanup(); }
});

test("artifacts: no ledger → an empty, clean view (never a crash)", () => {
  const r = repo({ "u.md": UP }, {});
  try {
    const a = view(r);
    assert.deepEqual(a.counts, { current: 0, drifted: 0, pages: 0 });
    assert.equal(a.byKey.size, 0);
    assert.equal(a.drift.length, 0);
    assert.equal(a.error, null);
  } finally { r.cleanup(); }
});

test("artifacts: a fingerprint for a page that no longer exists still reports drift, but carries no chip", () => {
  const r = repo({ "u.md": UP }, { "src.txt": "hello" });
  try {
    recordVerification(r.dir, { root: r.root, page: "Ghost", artifact: "src.txt", date: "2026-07-18" });
    r.write("src.txt", "changed");
    const a = view(r);
    assert.equal(a.counts.drifted, 1);
    assert.equal(a.drift[0].page, "Ghost");
    assert.equal(a.byKey.size, 0); // Ghost resolves to no board page → no per-page chip, but the drift is still surfaced
  } finally { r.cleanup(); }
});

test("artifacts: the projection is deterministic — identical input, identical output", () => {
  const r = repo({ "u.md": UP }, { "a.txt": "one", "b.txt": "two" });
  try {
    recordVerification(r.dir, { root: r.root, page: "Upstream", artifact: "a.txt", date: "2026-07-18" });
    recordVerification(r.dir, { root: r.root, page: "Upstream", artifact: "b.txt", date: "2026-07-18" });
    r.write("a.txt", "changed");
    const s = (a) => JSON.stringify({ counts: a.counts, drift: a.drift, byKey: [...a.byKey.entries()] });
    assert.equal(s(view(r)), s(view(r)));
  } finally { r.cleanup(); }
});
