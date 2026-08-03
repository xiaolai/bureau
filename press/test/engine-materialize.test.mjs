// engine/fsck --materialize-pages — the opt-in `effective_status:` legibility cache (ADR-0004
// Decision C). The derived effective-canonical tier is written into source pages WITHOUT touching the
// authored `status:` intent; plain `fsck` never mutates a page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { fsck } from "../src/engine/fsck.mjs";
import { appendEvent, logPath } from "../src/engine/log.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";

function ws(t, files) {
  const root = mkdtempSync(join(tmpdir(), "wb-mat-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}
const approve = (dir, file, uid, title) =>
  appendEvent(logPath(dir), { type: "approve", id: uid, by: "human", hash: reviewDigest({ raw: readFileSync(join(dir, file), "utf8"), uid, title }) });

test("materialize: writes effective_status: canonical WITHOUT overwriting authored status:", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\nstatus: proposed\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  approve(dir, "p.md", "P", "P");
  const r = fsck({ docsDir: dir, materializePages: true });
  assert.equal(r.materialized, 1, "one page materialized");
  const text = readFileSync(join(dir, "p.md"), "utf8");
  assert.match(text, /^status: proposed$/m, "authored intent preserved (never overwritten)");
  assert.match(text, /^effective_status: canonical$/m, "the derived effective tier is cached");
});

test("materialize: plain fsck (no flag) NEVER mutates a source page", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\nstatus: proposed\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  approve(dir, "p.md", "P", "P");
  const before = readFileSync(join(dir, "p.md"), "utf8");
  const r = fsck({ docsDir: dir }); // no materializePages
  assert.equal(r.materialized, 0, "plain fsck materializes nothing");
  assert.equal(readFileSync(join(dir, "p.md"), "utf8"), before, "the page is byte-identical after a plain fsck");
});

test("materialize: a page that is NOT effectively canonical has any stale cache removed", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\nstatus: proposed\neffective_status: canonical\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  // no approve event at all → P is not effectively canonical → the pre-existing cache must be cleared
  const r = fsck({ docsDir: dir, materializePages: true });
  assert.equal(r.materialized, 1, "the stale cache line is a change");
  const text = readFileSync(join(dir, "p.md"), "utf8");
  assert.doesNotMatch(text, /effective_status:/, "a non-effective page carries no effective_status cache");
  assert.match(text, /^status: proposed$/m, "authored status still intact");
});

test("materialize: an edit that staled the approval drops the page from the cache", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\nstatus: proposed\n---\n# P\noriginal ^p\n" });
  scan({ docsDir: dir });
  approve(dir, "p.md", "P", "P");
  fsck({ docsDir: dir, materializePages: true });
  assert.match(readFileSync(join(dir, "p.md"), "utf8"), /^effective_status: canonical$/m, "cached while current");
  // edit the body → the content-bound approval is stale → not effectively canonical → cache removed
  writeFileSync(join(dir, "p.md"), "---\nid: P\ntitle: P\nstatus: proposed\neffective_status: canonical\n---\n# P\nEDITED ^p\n");
  const r = fsck({ docsDir: dir, materializePages: true });
  assert.equal(r.materialized, 1);
  assert.doesNotMatch(readFileSync(join(dir, "p.md"), "utf8"), /effective_status:/, "a staled approval is dropped from the cache");
});
