// engine/review-queue — the shared typed-work-item model (ADR-0005 Decision A). Covers the dangerous
// cases the Codex critique named: dependency order, canonical-but-dirty (must NOT vanish), multi-page
// conflict components, stale/unbacked/broken-edge, unscanned edits, and cycles (must not hang).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { appendEvent, logPath } from "../src/engine/log.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";
import { reviewQueue } from "../src/engine/review-queue.mjs";

function ws(t, files) {
  const root = mkdtempSync(join(tmpdir(), "wb-rq-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}
const approve = (dir, file, uid, title) =>
  appendEvent(logPath(dir), { type: "approve", id: uid, by: "human", hash: reviewDigest({ raw: readFileSync(join(dir, file), "utf8"), uid, title }) });
const kindsFor = (q, kind) => q.items.filter((i) => i.kind === kind);
const restsOn = (page, span) => `rests_on:\n  - { page: "[[${page}]]", span: "${span}", because: "x" }`;

test("review-queue: orders approvable pages upstream-first over rests_on", (t) => {
  const dir = ws(t, {
    "c.md": "---\nid: C\ntitle: Cee\nstatus: proposed\n---\n# Cee\ndef ^c\n",
    "b.md": `---\nid: B\ntitle: Bee\nstatus: proposed\n${restsOn("Cee", "^c")}\n---\n# Bee\ndef ^b\n`,
    "a.md": `---\nid: A\ntitle: Ayy\nstatus: proposed\n${restsOn("Bee", "^b")}\n---\n# Ayy\nclaim ^a\n`,
  });
  scan({ docsDir: dir });
  const q = reviewQueue({ docsDir: dir });
  assert.deepEqual(q.items.map((i) => i.titles[0]), ["Cee", "Bee", "Ayy"], "the depended-on page comes first");
  assert.ok(q.items.every((i) => i.kind === "approve"), "all three are approve items");
});

test("review-queue: a CANONICAL page gone dependency-dirty is confirm-dependencies, not dropped", (t) => {
  const dir = ws(t, {
    "u.md": "---\nid: U\ntitle: Upstream\nstatus: proposed\n---\n# Upstream\nthe def ^u\n",
    "d.md": `---\nid: D\ntitle: Downstream\nstatus: proposed\n${restsOn("Upstream", "^u")}\n---\n# Downstream\nclaim ^d\n`,
  });
  scan({ docsDir: dir });
  approve(dir, "d.md", "D", "Downstream"); // D is now effectively canonical
  // edit the upstream span → D rests on a changed span → dependency-dirty (D's own bytes unchanged, so not stale)
  writeFileSync(join(dir, "u.md"), "---\nid: U\ntitle: Upstream\nstatus: proposed\n---\n# Upstream\nthe def CHANGED ^u\n");
  const q = reviewQueue({ docsDir: dir });
  const cd = kindsFor(q, "confirm-dependencies");
  assert.equal(cd.length, 1, "the canonical-but-dirty page surfaces (v1's filter dropped it)");
  assert.equal(cd[0].uids[0], "D");
});

test("review-queue: a contested pair is ONE resolve-conflict component holding both pages", (t) => {
  const dir = ws(t, {
    "p.md": "---\nid: P\ntitle: Pea\nstatus: proposed\ncontradicts: \"[[Que]]\"\n---\n# Pea\nclaim ^p\n",
    "q.md": "---\nid: Q\ntitle: Que\nstatus: proposed\n---\n# Que\nclaim ^q\n",
  });
  scan({ docsDir: dir });
  const q = reviewQueue({ docsDir: dir });
  const rc = kindsFor(q, "resolve-conflict");
  assert.equal(rc.length, 1, "one component, not two independent approves");
  assert.deepEqual(rc[0].uids.slice().sort(), ["P", "Q"], "both sides grouped, even though only P declared it");
  assert.ok(!q.items.some((i) => i.kind === "approve"), "neither side is offered as an independent approve");
});

test("review-queue: an edited-after-approval page is reapprove; an unbacked canonical is approve", (t) => {
  const dir = ws(t, {
    "s.md": "---\nid: S\ntitle: Ess\nstatus: proposed\n---\n# Ess\noriginal ^s\n",
    "x.md": "---\nid: X\ntitle: Ex\ntrust: canonical\n---\n# Ex\nclaim ^x\n", // authored canonical, NO approve
  });
  scan({ docsDir: dir });
  approve(dir, "s.md", "S", "Ess");
  writeFileSync(join(dir, "s.md"), "---\nid: S\ntitle: Ess\nstatus: proposed\n---\n# Ess\nEDITED ^s\n"); // stale
  const q = reviewQueue({ docsDir: dir });
  assert.equal(kindsFor(q, "reapprove").map((i) => i.uids[0])[0], "S");
  assert.equal(kindsFor(q, "approve").map((i) => i.uids[0])[0], "X");
});

test("review-queue: a rests_on to a missing target is repair-edge", (t) => {
  const dir = ws(t, { "y.md": `---\nid: Y\ntitle: Why\nstatus: proposed\n${restsOn("Ghost", "^g")}\n---\n# Why\nclaim ^y\n` });
  scan({ docsDir: dir });
  const q = reviewQueue({ docsDir: dir });
  assert.equal(kindsFor(q, "repair-edge").map((i) => i.uids[0])[0], "Y");
});

test("review-queue: a rests_on to an existing page's MISSING span is repair-edge, not confirm", (t) => {
  const dir = ws(t, {
    "u.md": "---\nid: U\ntitle: Upstream\nstatus: proposed\n---\n# Upstream\ndef ^u\n",
    "d.md": `---\nid: D\ntitle: Downstream\nstatus: proposed\n${restsOn("Upstream", "^ghostspan")}\n---\n# Downstream\nclaim ^d\n`,
  });
  scan({ docsDir: dir });
  const q = reviewQueue({ docsDir: dir });
  assert.equal(kindsFor(q, "repair-edge").map((i) => i.uids[0])[0], "D", "a broken SPAN (target exists, anchor missing) is repair-edge, not confirm");
});

test("review-queue: a 3-page conflict component carries the contradiction PAIRS", (t) => {
  const dir = ws(t, {
    "a.md": "---\nid: A\ntitle: Aaa\nstatus: proposed\ncontradicts: \"[[Bbb]]\"\n---\n# Aaa\nx ^a\n",
    "b.md": "---\nid: B\ntitle: Bbb\nstatus: proposed\ncontradicts: \"[[Ccc]]\"\n---\n# Bbb\nx ^b\n",
    "c.md": "---\nid: C\ntitle: Ccc\nstatus: proposed\n---\n# Ccc\nx ^c\n",
  });
  scan({ docsDir: dir });
  const rc = kindsFor(reviewQueue({ docsDir: dir }), "resolve-conflict");
  assert.equal(rc.length, 1, "one component for the A-B-C chain");
  assert.deepEqual(rc[0].uids.slice().sort(), ["A", "B", "C"]);
  assert.equal(rc[0].pairs.length, 2, "two contradiction pairs (A×B, B×C) — resolve pairwise, not one 3-arg command");
});

test("review-queue: a contested component is ordered AFTER a dependency one of its members rests on", (t) => {
  const dir = ws(t, {
    "a.md": "---\nid: A\ntitle: Aaa\nstatus: proposed\ncontradicts: \"[[Ddd]]\"\n---\n# Aaa\nx ^a\n",
    "u.md": "---\nid: U\ntitle: Uuu\nstatus: proposed\n---\n# Uuu\ndef ^u\n",
    "d.md": `---\nid: D\ntitle: Ddd\nstatus: proposed\n${restsOn("Uuu", "^u")}\n---\n# Ddd\nx ^d\n`,
  });
  scan({ docsDir: dir });
  const items = reviewQueue({ docsDir: dir }).items;
  const uIdx = items.findIndex((i) => i.uids[0] === "U");
  const cIdx = items.findIndex((i) => i.kind === "resolve-conflict");
  assert.ok(uIdx >= 0 && cIdx >= 0 && uIdx < cIdx, "Uuu (a dependency of Ddd) precedes the A×D component (super-vertex ordering)");
});

test("review-queue: an effectively-canonical, current, conflict-free page is absent", (t) => {
  const dir = ws(t, { "z.md": "---\nid: Z\ntitle: Zed\nstatus: proposed\n---\n# Zed\nclaim ^z\n" });
  scan({ docsDir: dir });
  approve(dir, "z.md", "Z", "Zed");
  const q = reviewQueue({ docsDir: dir });
  assert.equal(q.items.length, 0, "nothing to review");
});

test("review-queue: a rests_on cycle does not hang and still lists both pages", (t) => {
  const dir = ws(t, {
    "a.md": `---\nid: A\ntitle: Aay\nstatus: proposed\n${restsOn("Bee", "^b")}\n---\n# Aay\nclaim ^a\n`,
    "b.md": `---\nid: B\ntitle: Bee\nstatus: proposed\n${restsOn("Aay", "^a")}\n---\n# Bee\nclaim ^b\n`,
  });
  scan({ docsDir: dir });
  const q = reviewQueue({ docsDir: dir });
  assert.equal(q.items.length, 2, "both pages present despite the cycle");
  assert.deepEqual(q.items.map((i) => i.uids[0]).slice().sort(), ["A", "B"]);
});
