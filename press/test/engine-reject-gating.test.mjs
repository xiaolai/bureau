// engine/state — reject is now authority-gated (reuses `approve` authority) and scope-aware (ADR-0004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDecisions } from "../src/engine/state.mjs";
import { DEFAULT_POLICY } from "../src/engine/policy.mjs";
import { scan } from "../src/engine/scan.mjs";
import { fsck } from "../src/engine/fsck.mjs";
import { appendEvent, logPath } from "../src/engine/log.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";

test("reject gating: an unauthorized (machine) reject can NOT revoke a human approval", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice" },   // human → effective
    { seq: 2, type: "reject", id: "u1", by: "llm" },      // machine reject under human-only policy
  ], DEFAULT_POLICY);
  assert.equal(d.approved.get("u1"), "canonical", "the human approval still stands (reject is inert)");
  assert.equal(d.unauthorizedRejections.get("u1"), "llm", "the inert reject is recorded for reporting");
});

test("reject gating: an authorized (human) reject un-approves (legacy behaviour preserved)", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice" },
    { seq: 2, type: "reject", id: "u1", by: "bob" },
  ], DEFAULT_POLICY);
  assert.equal(d.approved.has("u1"), false, "a human reject revokes");
});

test("reject gating: policy-less callers keep exact legacy behaviour (every reject un-approves)", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "llm" },   // no policy → effective
    { seq: 2, type: "reject", id: "u1", by: "llm" },    // no policy → un-approves (old behaviour)
  ], null);
  assert.equal(d.approved.has("u1"), false);
});

test("scoped reject: targeting a SUPERSEDED approval is inert; the current approval stands", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice", hash: "h1" },
    { seq: 2, type: "approve", id: "u1", by: "alice", hash: "h2" },      // supersedes seq 1
    { seq: 3, type: "reject", id: "u1", by: "alice", approval_seq: 1 },  // targets the OLD approval
  ], DEFAULT_POLICY);
  assert.equal(d.approved.get("u1"), "canonical", "current approval (seq 2) stands");
  assert.equal(d.approvedHash.get("u1"), "h2");
  assert.equal(d.staleRejections.length, 1);
  assert.equal(d.staleRejections[0].why, "targets-superseded-approval");
});

test("scoped reject: targeting the ACTIVE approval revokes it", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice", approval_seq: undefined },
    { seq: 2, type: "reject", id: "u1", by: "alice", approval_seq: 1 },
  ], DEFAULT_POLICY);
  assert.equal(d.approved.has("u1"), false);
});

test("scoped reject: with no active approval is inert (recorded stale, never a phantom revocation)", () => {
  const d = projectDecisions([
    { seq: 1, type: "reject", id: "u1", by: "alice", approval_seq: 1 },
  ], DEFAULT_POLICY);
  assert.equal(d.approved.has("u1"), false);
  assert.equal(d.staleRejections[0].why, "no-active-approval");
});

test("approve stores the reviewed hash + seq for content-binding", () => {
  const d = projectDecisions([{ seq: 7, type: "approve", id: "u1", by: "alice", hash: "bureau-page-v1:abc" }], DEFAULT_POLICY);
  assert.equal(d.approvedHash.get("u1"), "bureau-page-v1:abc");
  assert.equal(d.approvedSeq.get("u1"), 7);
});

test("reject gating: a prior INERT (unauthorized) reject is CLEARED once a human decision follows", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice" },
    { seq: 2, type: "reject", id: "u1", by: "llm" },   // inert, recorded
    { seq: 3, type: "reject", id: "u1", by: "bob" },   // human → revokes AND clears the inert record
  ], DEFAULT_POLICY);
  assert.equal(d.approved.has("u1"), false);
  assert.equal(d.unauthorizedRejections.has("u1"), false, "no lingering unauthorized-reject finding");
});

test("reject gating: an authorized reject clears a recorded unauthorized APPROVE (no lingering finding)", () => {
  const d = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "llm" },                   // unauthorized under human-only
    { seq: 2, type: "reject", id: "u1", by: "alice", approval_seq: 1 }, // a human addresses it
  ], DEFAULT_POLICY);
  assert.equal(d.unauthorizedApprovals.has("u1"), false, "the unauthorized-canonical record is cleared");
});

test("scoped reject: an approval_hash MISMATCH is inert; a matching hash revokes", () => {
  const stale = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice", hash: "good" },
    { seq: 2, type: "reject", id: "u1", by: "alice", approval_seq: 1, approval_hash: "wrong" },
  ], DEFAULT_POLICY);
  assert.equal(stale.approved.get("u1"), "canonical", "a mismatched approval_hash does not revoke");
  const revoked = projectDecisions([
    { seq: 1, type: "approve", id: "u1", by: "alice", hash: "good" },
    { seq: 2, type: "reject", id: "u1", by: "alice", approval_seq: 1, approval_hash: "good" },
  ], DEFAULT_POLICY);
  assert.equal(revoked.approved.has("u1"), false, "a matching approval_hash revokes");
});

test("fsck: an unauthorized (machine) reject under the human-only policy surfaces `unauthorized-reject`", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-reject-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(dir, "p.md"), "---\nid: P\ntitle: P\n---\n# P\nthe claim ^p\n");
  scan({ docsDir: dir });                                            // records the corpus into the log
  appendEvent(logPath(dir), { type: "approve", id: "P", by: "alice" }); // human → effective
  appendEvent(logPath(dir), { type: "reject", id: "P", by: "llm" });    // machine → inert under human-only
  const f = fsck({ docsDir: dir }).findings.find((x) => x.kind === "unauthorized-reject");
  assert.ok(f, "unauthorized-reject finding is emitted");
  assert.equal(f.uid, "P");
  assert.equal(f.by, "llm");
});

test("fsck: content-binding surfaces unbound-approval (hashless) and stale-approval (edited after review)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-bind-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const P = join(dir, "p.md");
  writeFileSync(P, "---\nid: P\ntitle: P\nclaim: original\n---\n# P\nbody ^p\n");
  scan({ docsDir: dir });
  // (a) a HASHLESS approval → unbound-approval (advisory nudge)
  appendEvent(logPath(dir), { type: "approve", id: "P", by: "alice" });
  let f = fsck({ docsDir: dir }).findings;
  assert.ok(f.some((x) => x.kind === "unbound-approval" && x.uid === "P"), "hashless approval is unbound");
  // (b) a HASHED approval matching the current page → neither unbound nor stale
  const h = reviewDigest({ raw: readFileSync(P, "utf8"), uid: "P", title: "P" });
  appendEvent(logPath(dir), { type: "approve", id: "P", by: "alice", hash: h }); // supersedes; hashed + matching
  f = fsck({ docsDir: dir }).findings;
  assert.ok(!f.some((x) => x.kind === "unbound-approval"), "now hash-bound, not unbound");
  assert.ok(!f.some((x) => x.kind === "stale-approval"), "matches current content, not stale");
  // (c) EDIT the page → the hashed approval no longer matches → stale-approval
  writeFileSync(P, "---\nid: P\ntitle: P\nclaim: EDITED\n---\n# P\nbody ^p\n");
  const r = fsck({ docsDir: dir });
  assert.ok(r.findings.some((x) => x.kind === "stale-approval" && x.uid === "P"), "edited after approval → stale");
  assert.equal(r.ok, true, "stale-approval is ADVISORY — it does not by itself force ok:false (would fail if removed from ADVISORY)");
  assert.ok(!r.blockingFindings.some((x) => x.kind === "stale-approval"), "stale-approval is not a blocking finding");
});

test("legacy manifest: grandfathers an unbacked authored-canonical as advisory legacy-canonical, voided on edit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-legacy-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const P = join(dir, "p.md");
  writeFileSync(P, "---\nid: P\ntitle: P\ntrust: canonical\n---\n# P\nclaim ^p\n"); // authored canonical, NO approve
  scan({ docsDir: dir });
  let r = fsck({ docsDir: dir });
  assert.ok(r.findings.some((x) => x.kind === "unbacked-canonical" && x.uid === "P"), "unbacked before migration");
  assert.equal(r.ok, false, "unbacked-canonical BLOCKS fsck");
  // grandfather it: pin the current digest
  const pin = reviewDigest({ raw: readFileSync(P, "utf8"), uid: "P", title: "P" });
  writeFileSync(join(dir, "_legacy-canonical.json"), JSON.stringify({ schema: 1, pins: { P: pin } }));
  r = fsck({ docsDir: dir });
  assert.ok(r.findings.some((x) => x.kind === "legacy-canonical" && x.uid === "P"), "grandfathered → legacy-canonical");
  assert.ok(!r.findings.some((x) => x.kind === "unbacked-canonical"), "no longer unbacked");
  assert.equal(r.ok, true, "legacy-canonical is ADVISORY — fsck ok again");
  // edit the page → digest mismatch → grandfather VOID → unbacked (blocking) again
  writeFileSync(P, "---\nid: P\ntitle: P\ntrust: canonical\n---\n# P\nEDITED ^p\n");
  r = fsck({ docsDir: dir });
  assert.ok(r.findings.some((x) => x.kind === "unbacked-canonical" && x.uid === "P"), "an edit voids the grandfather → unbacked again");
  assert.equal(r.ok, false, "and it blocks again");
});

test("legacy manifest: grandfathers an UNBOUND (real but hashless) approval as legacy-canonical", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-legacy2-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const P = join(dir, "p.md");
  writeFileSync(P, "---\nid: P\ntitle: P\n---\n# P\nclaim ^p\n");
  scan({ docsDir: dir });
  appendEvent(logPath(dir), { type: "approve", id: "P", by: "alice" }); // real approve, hashless → unbound
  assert.ok(fsck({ docsDir: dir }).findings.some((x) => x.kind === "unbound-approval" && x.uid === "P"), "unbound before migration");
  writeFileSync(join(dir, "_legacy-canonical.json"), JSON.stringify({ schema: 1, pins: { P: reviewDigest({ raw: readFileSync(P, "utf8"), uid: "P", title: "P" }) } }));
  const r = fsck({ docsDir: dir });
  assert.ok(r.findings.some((x) => x.kind === "legacy-canonical" && x.uid === "P"), "grandfathered → legacy-canonical");
  assert.ok(!r.findings.some((x) => x.kind === "unbound-approval"), "no longer unbound");
});

test("log validation: the new optional approve/reject fields reject malformed values via appendEvent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-logval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lp = join(root, "_log.jsonl");
  assert.doesNotThrow(() => appendEvent(lp, { type: "approve", id: "P", hash: "bureau-page-v1:abc" }), "valid hashed approve");
  assert.doesNotThrow(() => appendEvent(lp, { type: "reject", id: "P", approval_seq: 1, approval_hash: "h" }), "valid scoped reject");
  assert.throws(() => appendEvent(lp, { type: "approve", id: "P", hash: "" }), /malformed approve/, "empty hash");
  assert.throws(() => appendEvent(lp, { type: "reject", id: "P", approval_seq: 0 }), /malformed reject/, "non-positive seq");
  assert.throws(() => appendEvent(lp, { type: "reject", id: "P", approval_seq: 1.5 }), /malformed reject/, "non-integer seq");
  assert.throws(() => appendEvent(lp, { type: "reject", id: "P", approval_seq: "1" }), /malformed reject/, "string seq");
  assert.throws(() => appendEvent(lp, { type: "reject", id: "P", approval_hash: "" }), /malformed reject/, "empty approval_hash");
});
