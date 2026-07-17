// WI-4 — span revisions (revert-aware), verdict key, scan producer, decided-state projection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRevisions, spanRevision, verdictKey, becauseDigest } from "../src/engine/revisions.mjs";
import { projectDecisions, resolveNodeState } from "../src/engine/state.mjs";
import { scan } from "../src/engine/scan.mjs";
import { readLog, appendEvent, logPath } from "../src/engine/log.mjs";

function ws() {
  const root = mkdtempSync(join(tmpdir(), "wb-rev-"));
  const dir = join(root, "canon");
  mkdirSync(dir, { recursive: true });
  return { dir, write: (rel, body) => writeFileSync(join(dir, rel), body), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("projectRevisions: A→B→A revert yields r1→r2→r3, all distinct (NOT a content hash)", () => {
  const events = [
    { seq: 1, type: "introduce", id: "P", span: "^c", hash: "HA" },
    { seq: 2, type: "edit", id: "P", span: "^c", hash: "HB", prev: "HA" },
    { seq: 3, type: "edit", id: "P", span: "^c", hash: "HA", prev: "HB" }, // content back to A
  ];
  assert.equal(spanRevision(projectRevisions(events), "P", "^c"), 3);
});

test("verdictKey: changes on target-rev, on because, on dep-span — same inputs → same key", () => {
  const base = { targetUid: "T", targetSpan: "^t", targetRev: 1, depUid: "D", depSpan: "^d", depRev: 1, becauseDig: becauseDigest("x"), schemaVersion: 1 };
  const k0 = verdictKey(base);
  assert.equal(k0, verdictKey({ ...base }));                                  // deterministic
  assert.notEqual(k0, verdictKey({ ...base, targetRev: 2 }));                 // upstream churned
  assert.notEqual(k0, verdictKey({ ...base, becauseDig: becauseDigest("y") }));// justification changed
  assert.notEqual(k0, verdictKey({ ...base, depSpan: "^d2" }));               // downstream claim moved
});

test("scan: introduce → edit → edit(revert) as the file's span content changes", () => {
  const w = ws();
  try {
    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nclaim A ^c\n");
    scan({ docsDir: w.dir });
    assert.equal(spanRevision(projectRevisions(readLog(logPath(w.dir))), "P", "^c"), 1);

    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nclaim B ^c\n");
    scan({ docsDir: w.dir });
    assert.equal(spanRevision(projectRevisions(readLog(logPath(w.dir))), "P", "^c"), 2);

    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nclaim A ^c\n"); // revert
    const r = scan({ docsDir: w.dir });
    assert.equal(r.summary.edited, 1);
    assert.equal(spanRevision(projectRevisions(readLog(logPath(w.dir))), "P", "^c"), 3);
  } finally { w.cleanup(); }
});

test("scan: an edit OUTSIDE the cited span does not bump its revision (cosmetic cutoff)", () => {
  const w = ws();
  try {
    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nthe claim ^c\n\nan unrelated paragraph\n");
    scan({ docsDir: w.dir });
    // edit only the unrelated paragraph — the span block ending at ^c is untouched
    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nthe claim ^c\n\ntotally different prose now\n");
    const r = scan({ docsDir: w.dir });
    assert.equal(r.summary.edited, 0); // no span change → no event
    assert.equal(spanRevision(projectRevisions(readLog(logPath(w.dir))), "P", "^c"), 1);
  } finally { w.cleanup(); }
});

test("scan: a removed anchor emits a delete", () => {
  const w = ws();
  try {
    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nclaim ^c\n");
    scan({ docsDir: w.dir });
    w.write("p.md", "---\nid: P\ntitle: Pee\n---\n# Pee\nclaim with no anchor now\n");
    const r = scan({ docsDir: w.dir });
    assert.equal(r.summary.deleted, 1);
    assert.equal(spanRevision(projectRevisions(readLog(logPath(w.dir))), "P", "^c"), 0); // dead
  } finally { w.cleanup(); }
});

test("state: canonical is a projection — an approve event backs it; authored canonical alone does not", () => {
  const events = [{ seq: 1, type: "approve", id: "P", to_trust: "canonical", by: "u" }];
  const dec = projectDecisions(events);
  const backed = resolveNodeState({ uid: "P", trust: "proposed" }, dec);
  assert.equal(backed.trust, "canonical");
  assert.equal(backed.trustBacked, true);
  const unbacked = resolveNodeState({ uid: "Q", trust: "canonical" }, dec); // authored, no approval
  assert.equal(unbacked.trust, "canonical");
  assert.equal(unbacked.trustBacked, false);
});

test("state: contested until a resolve event lands, then resolved with a resolution_id", () => {
  let dec = projectDecisions([]);
  const contested = resolveNodeState({ uid: "A", trust: "proposed" }, dec, ["B"]);
  assert.equal(contested.conflict, "contested");
  dec = projectDecisions([{ seq: 5, type: "resolve", conflict: ["A", "B"].sort().join(" × "), winner: "A", resolution_id: 5 }]);
  const resolved = resolveNodeState({ uid: "A", trust: "proposed" }, dec, ["B"]);
  assert.equal(resolved.conflict, "resolved");
  assert.equal(resolved.resolutionId, 5);
});
