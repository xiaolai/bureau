// engine/state — commit-gated batch transactions (ADR-0005 Decision B). A decision inside a batch takes
// effect ONLY once its `batch-commit` is present; a crash mid-append (no commit) projects to nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectDecisions } from "../src/engine/state.mjs";

test("batch: a committed batch's approves take effect", () => {
  const d = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "b1", mode: "from", n: 2, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "A", by: "human", hash: "h", batch_id: "b1" },
    { seq: 3, type: "approve", id: "B", by: "human", hash: "h", batch_id: "b1" },
    { seq: 4, type: "batch-commit", batch_id: "b1" },
  ]);
  assert.ok(d.approved.has("A") && d.approved.has("B"), "both approvals in the committed batch are effective");
});

test("batch: an UNcommitted batch (crash before batch-commit) projects to nothing", () => {
  const d = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "b1", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "A", by: "human", hash: "h", batch_id: "b1" },
    // ← crash here: no batch-commit
  ]);
  assert.ok(!d.approved.has("A"), "an uncommitted approve never took effect");
});

test("batch: an abandoned (uncommitted) batch is superseded by a later committed one", () => {
  const d = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "b1", mode: "all", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "A", by: "human", hash: "h", batch_id: "b1" }, // abandoned
    { seq: 3, type: "batch-begin", batch_id: "b2", mode: "all", n: 1, manifest_digest: "m", by: "human" },
    { seq: 4, type: "approve", id: "A", by: "human", hash: "h2", batch_id: "b2" },
    { seq: 5, type: "batch-commit", batch_id: "b2" },
  ]);
  assert.ok(d.approved.has("A"), "the committed rerun took effect");
  assert.equal(d.approvedHash.get("A"), "h2", "and it is the committed batch's approval, not the abandoned one");
});

test("batch: a plain (non-batch) approve is unaffected by batch gating", () => {
  const d = projectDecisions([{ seq: 1, type: "approve", id: "A", by: "human" }]);
  assert.ok(d.approved.has("A"), "an event with no batch_id projects exactly as before");
});

test("batch: malformed brackets are inert — commit-without-begin, count mismatch, member after commit", () => {
  // a commit with no begin authorizes nothing
  assert.ok(!projectDecisions([
    { seq: 1, type: "approve", id: "A", by: "human", batch_id: "b" },
    { seq: 2, type: "batch-commit", batch_id: "b" },
  ]).approved.has("A"), "commit with no begin is inert");
  // begin claims n:2 but only one member arrives → count mismatch voids the batch
  assert.ok(!projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "b", mode: "from", n: 2, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "A", by: "human", batch_id: "b" },
    { seq: 3, type: "batch-commit", batch_id: "b" },
  ]).approved.has("A"), "a count mismatch voids the batch");
  // a member appended AFTER the commit is outside the bracket
  assert.ok(!projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "b", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "batch-commit", batch_id: "b" },
    { seq: 3, type: "approve", id: "A", by: "human", batch_id: "b" },
  ]).approved.has("A"), "a member after commit is outside the bracket");
  // a duplicate begin for the same id voids it
  assert.ok(!projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "b", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "batch-begin", batch_id: "b", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 3, type: "approve", id: "A", by: "human", hash: "h", batch_id: "b" },
    { seq: 4, type: "batch-commit", batch_id: "b" },
  ]).approved.has("A"), "a duplicate begin voids the batch");
});

test("batch: crossed (non-contiguous) batches and hashless batch approvals are inert", () => {
  // begin A, begin B, member A, member B, commit A, commit B — not a contiguous bracket
  const crossed = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "A", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "batch-begin", batch_id: "B", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 3, type: "approve", id: "x", by: "human", hash: "h", batch_id: "A" },
    { seq: 4, type: "approve", id: "y", by: "human", hash: "h", batch_id: "B" },
    { seq: 5, type: "batch-commit", batch_id: "A" },
    { seq: 6, type: "batch-commit", batch_id: "B" },
  ]);
  assert.ok(!crossed.approved.has("x") && !crossed.approved.has("y"), "crossed batches are both inert");
  // a batch approval with no hash is inert — a batch approval must pin the reviewed bytes
  const hashless = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "A", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "x", by: "human", batch_id: "A" },
    { seq: 3, type: "batch-commit", batch_id: "A" },
  ]);
  assert.ok(!hashless.approved.has("x"), "a hashless batch approval is inert");
});

test("batch: a stray event reusing a batch id TOMBSTONES the whole batch (id reuse = corruption)", () => {
  const d = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "A", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "x", by: "human", hash: "h", batch_id: "A" },
    { seq: 3, type: "batch-commit", batch_id: "A" },
    { seq: 4, type: "approve", id: "y", by: "human", hash: "h", batch_id: "A" }, // stray reuse of committed id A
  ]);
  // batch ids are stable + content-addressed, so id reuse only arises from corruption/tampering — distrust
  // EVERYTHING carrying that id, including the otherwise-valid bracket.
  assert.ok(!d.approved.has("x") && !d.approved.has("y"), "id reuse tombstones the entire batch");
});

test("batch: a duplicate commit tombstones an otherwise-valid bracket", () => {
  const d = projectDecisions([
    { seq: 1, type: "batch-begin", batch_id: "A", mode: "from", n: 1, manifest_digest: "m", by: "human" },
    { seq: 2, type: "approve", id: "x", by: "human", hash: "h", batch_id: "A" },
    { seq: 3, type: "batch-commit", batch_id: "A" },
    { seq: 4, type: "batch-commit", batch_id: "A" }, // duplicate commit → extra tagged event
  ]);
  assert.ok(!d.approved.has("x"), "a duplicate commit voids the batch (total-count check)");
});
