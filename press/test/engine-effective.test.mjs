// engine/effective — the ONE reader-facing projection of content-bound trust (ADR-0004 Decision C).
// A reader (the chamber review queue, the board tier) must key off THIS, not authored/stamped
// frontmatter, so a stale approval stops counting as canonical and re-enters review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { appendEvent, logPath } from "../src/engine/log.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";
import { effectiveReview } from "../src/engine/effective.mjs";

function ws(t, files) {
  const root = mkdtempSync(join(tmpdir(), "wb-eff-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}

test("effectiveReview: a content-bound approval is canonical; an edit demotes it to needs-review", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\nstatus: proposed\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  // hashless approve alone → the page is projected canonical but UNBOUND (advisory), still "canonical"
  // for a reader (a real human approval); binding comes next.
  const h = reviewDigest({ raw: readFileSync(join(dir, "p.md"), "utf8"), uid: "P", title: "P" });
  appendEvent(logPath(dir), { type: "approve", id: "P", by: "human", hash: h });
  let e = effectiveReview({ docsDir: dir });
  assert.ok(e.canonical.has("P"), "content-bound approval → effectively canonical");
  assert.ok(!e.needsReview.has("P"), "not flagged for re-review while bytes match");

  // edit the page after approval → the hash no longer matches → NOT canonical, MUST re-enter review
  writeFileSync(join(dir, "p.md"), "---\nid: P\ntitle: P\nstatus: proposed\n---\n# P\nEDITED ^p\n");
  e = effectiveReview({ docsDir: dir });
  assert.ok(!e.canonical.has("P"), "a stale approval is NOT effectively canonical");
  assert.ok(e.needsReview.has("P"), "a stale approval re-enters the review queue");
});

test("effectiveReview: an authored `canonical` with no backing approve is needs-review, not canonical", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\ntrust: canonical\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  const e = effectiveReview({ docsDir: dir });
  assert.ok(!e.canonical.has("P"), "unbacked authored-canonical is not effectively canonical");
  assert.ok(e.needsReview.has("P"), "an unbacked canonical needs review");
});

test("effectiveReview: a grandfathered legacy-canonical stays canonical (accepted), not needs-review", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\ntrust: canonical\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  const pin = reviewDigest({ raw: readFileSync(join(dir, "p.md"), "utf8"), uid: "P", title: "P" });
  writeFileSync(join(dir, "_legacy-canonical.json"), JSON.stringify({ schema: 1, pins: { P: pin } }));
  const e = effectiveReview({ docsDir: dir });
  assert.ok(e.canonical.has("P"), "grandfathered → accepted as canonical");
  assert.ok(!e.needsReview.has("P"), "grandfathered is not flagged for re-review");
});

test("effectiveReview: a plain proposed page is neither canonical nor needs-review", (t) => {
  const dir = ws(t, { "p.md": "---\nid: P\ntitle: P\nstatus: proposed\n---\n# P\nbody ^p\n" });
  scan({ docsDir: dir });
  const e = effectiveReview({ docsDir: dir });
  assert.ok(!e.canonical.has("P") && !e.needsReview.has("P"), "an un-decided proposed page is outside both sets");
});
