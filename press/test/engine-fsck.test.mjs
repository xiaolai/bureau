// WI-7 - fsck: rebuild the mechanical-derived tier to a byte-fixpoint; verify integrity + findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { fsck, gateCachePath } from "../src/engine/fsck.mjs";
import { logPath, appendEvent } from "../src/engine/log.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";
import { loadCorpus, buildModel } from "../src/core/model.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-fsck-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const UP = "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe def ^u\n";
const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses\" }\n---\n# Downstream\nthe claim ^d\n";

test("fsck: derived tier rebuilds to a byte-fixpoint (build twice -> identical digest and cache)", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const a = fsck({ docsDir: w.dir });
    const cacheA = readFileSync(gateCachePath(w.dir), "utf8");
    const b = fsck({ docsDir: w.dir });
    assert.equal(a.digest, b.digest);
    assert.equal(a.fixpointStable, true);
    assert.equal(readFileSync(gateCachePath(w.dir), "utf8"), cacheA);
  } finally { w.cleanup(); }
});

test("fsck: dropping the mechanical cache and rebuilding reproduces identical bytes (regenerability)", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const first = fsck({ docsDir: w.dir });
    const bytes = readFileSync(gateCachePath(w.dir), "utf8");
    rmSync(gateCachePath(w.dir));                       // drop the derived cache
    const rebuilt = fsck({ docsDir: w.dir });
    assert.equal(rebuilt.digest, first.digest);
    assert.equal(readFileSync(gateCachePath(w.dir), "utf8"), bytes); // byte-identical
  } finally { w.cleanup(); }
});

test("fsck: a tampered log line is caught (integrity gate), not silently rebuilt", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const lf = logPath(w.dir);
    const lines = readFileSync(lf, "utf8").split("\n").filter(Boolean);
    const forged = JSON.parse(lines[0]); forged.hash = "TAMPERED";
    lines[0] = JSON.stringify(forged);
    writeFileSync(lf, lines.join("\n") + "\n");
    assert.throws(() => fsck({ docsDir: w.dir }), /integrity check failed/);
  } finally { w.cleanup(); }
});

test("fsck: reports pending-scan when the log does not yet reflect the corpus", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    const r = fsck({ docsDir: w.dir }); // never scanned
    assert.ok(r.findings.some((f) => f.kind === "pending-scan"));
  } finally { w.cleanup(); }
});

test("fsck: an authored canonical with no approve event is reported unbacked", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: Pee\ntrust: canonical\n---\n# Pee\nx ^p\n" });
  try {
    scan({ docsDir: w.dir });
    const r = fsck({ docsDir: w.dir });
    assert.ok(r.findings.some((f) => f.kind === "unbacked-canonical" && f.uid === "P"));
  } finally { w.cleanup(); }
});

// ── WI-3 (ADR layer): `superseded` is a fsck-level projection beside stale-approval/contested ──
// `buildDerived` stays untouched (byte-fixpoint by construction); superseded is exposed on
// report.superseded and excluded from effective-canonical. Effectiveness gates on the source's
// FRESH (content-current) approval; the target must be an eligible decision. Cycles fail-closed.
const MSN = "---\nid: M\ntitle: ADR M\nsupersedes: [[ADR N]]\n---\n# ADR M\nbody ^m\n";
const NPLAIN = "---\nid: N\ntitle: ADR N\n---\n# ADR N\nbody ^n\n";
function approveBound(dir, uid, title, file) {
  const raw = readFileSync(join(dir, file), "utf8");
  appendEvent(logPath(dir), { type: "approve", id: uid, by: "human", hash: reviewDigest({ raw, uid, title }) });
}

test("WI-3: inert supersedes (unapproved source) → derived digest == committed baseline, no superseded", () => {
  const w = ws({ "m.md": MSN, "n.md": NPLAIN });
  try {
    scan({ docsDir: w.dir });
    const r = fsck({ docsDir: w.dir });
    // Frozen pre-WI-3 literal: buildDerived is untouched, so this is the guard against ANY leak of
    // `superseded` into the derived tier. (build-twice determinism alone cannot catch such a leak.)
    assert.equal(r.digest, "18716df890bc489c760ead304a6c7499c86581a2c1556f1adab11711fdade558");
    assert.equal(r.superseded.size, 0);
    assert.ok(r.derived.decided.every((d) => !("supersededBy" in d)));
  } finally { w.cleanup(); }
});

test("WI-3: effective supersession → report.superseded on target only, buildDerived untouched, fixpoint holds", () => {
  const w = ws({ "m.md": MSN, "n.md": NPLAIN });
  try {
    scan({ docsDir: w.dir });
    approveBound(w.dir, "N", "ADR N", "n.md"); // N is an eligible (effective-canonical) decision
    approveBound(w.dir, "M", "ADR M", "m.md"); // M fresh-approved → supersession is effective
    const r = fsck({ docsDir: w.dir });
    assert.deepEqual(r.superseded.get("N"), ["M"]);
    assert.equal(r.superseded.has("M"), false);
    assert.ok(r.derived.decided.every((d) => !("supersededBy" in d)), "buildDerived carries no supersededBy key");
    assert.equal(r.fixpointStable, true);
  } finally { w.cleanup(); }
});

test("WI-3: broken-supersedes is advisory (finding present, fsck.ok stays true)", () => {
  const w = ws({ "m.md": "---\nid: M\ntitle: ADR M\nsupersedes: [[ADR Ghost]]\n---\n# ADR M\nbody ^m\n" });
  try {
    scan({ docsDir: w.dir });
    const r = fsck({ docsDir: w.dir });
    assert.ok(r.findings.some((f) => f.kind === "broken-supersedes" && f.sourceUid === "M" && f.target === "ADR Ghost"));
    assert.equal(r.ok, true);
    assert.ok(!r.blockingFindings.some((f) => f.kind === "broken-supersedes"));
  } finally { w.cleanup(); }
});

test("WI-3: supersedes-ineligible-target is advisory; a proposed target is NOT demoted", () => {
  const w = ws({ "m.md": MSN, "n.md": NPLAIN });
  try {
    scan({ docsDir: w.dir });
    approveBound(w.dir, "M", "ADR M", "m.md"); // M fresh-approved, but N stays proposed → ineligible target
    const r = fsck({ docsDir: w.dir });
    assert.ok(r.findings.some((f) => f.kind === "supersedes-ineligible-target" && f.sourceUid === "M" && f.targetUid === "N"));
    assert.equal(r.ok, true);
    assert.equal(r.superseded.has("N"), false);
  } finally { w.cleanup(); }
});

test("WI-3: approved A↔B supersede-cycle BLOCKS; an unapproved (inert) cycle does NOT", () => {
  const A = "---\nid: A\ntitle: ADR A\nsupersedes: [[ADR B]]\n---\n# ADR A\nbody ^a\n";
  const B = "---\nid: B\ntitle: ADR B\nsupersedes: [[ADR A]]\n---\n# ADR B\nbody ^b\n";
  const w1 = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w1.dir });
    approveBound(w1.dir, "A", "ADR A", "a.md");
    approveBound(w1.dir, "B", "ADR B", "b.md");
    const r1 = fsck({ docsDir: w1.dir });
    assert.ok(r1.findings.some((f) => f.kind === "supersedes-cycle"));
    assert.equal(r1.ok, false); // an effective cycle is a real contradiction — blocking
  } finally { w1.cleanup(); }
  const w2 = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w2.dir }); // neither approved → both edges inert
    const r2 = fsck({ docsDir: w2.dir });
    assert.ok(!r2.findings.some((f) => f.kind === "supersedes-cycle"), "an inert cycle must not block the CI gate");
    assert.equal(r2.ok, true);
  } finally { w2.cleanup(); }
});

test("WI-3: --materialize-pages never stamps a superseded target effective_status: canonical", () => {
  const K = "---\nid: K\ntitle: ADR K\n---\n# ADR K\nbody ^k\n";
  const w = ws({ "m.md": MSN, "n.md": NPLAIN, "k.md": K });
  try {
    scan({ docsDir: w.dir });
    approveBound(w.dir, "N", "ADR N", "n.md");
    approveBound(w.dir, "M", "ADR M", "m.md");
    approveBound(w.dir, "K", "ADR K", "k.md"); // control: canonical, NOT superseded
    fsck({ docsDir: w.dir, write: true, materializePages: true });
    assert.doesNotMatch(readFileSync(join(w.dir, "n.md"), "utf8"), /effective_status:\s*canonical/); // superseded N excluded
    assert.match(readFileSync(join(w.dir, "k.md"), "utf8"), /effective_status:\s*canonical/); // control stamped → materialize ran
  } finally { w.cleanup(); }
});

test("WI-3: a hashless (unbound) approved source does NOT activate supersession (fail-closed)", () => {
  const w = ws({ "m.md": MSN, "n.md": NPLAIN });
  try {
    scan({ docsDir: w.dir });
    approveBound(w.dir, "N", "ADR N", "n.md");                             // N eligible
    appendEvent(logPath(w.dir), { type: "approve", id: "M", by: "human" }); // HASHLESS approve of M
    const r = fsck({ docsDir: w.dir });
    assert.equal(r.superseded.size, 0); // M not content-current (no hash) → supersession inert
    assert.ok(r.findings.some((f) => f.kind === "unbound-approval" && f.uid === "M"));
    assert.equal(r.ok, true); // unbound-approval is advisory
  } finally { w.cleanup(); }
});

// ── G1 (ADR reader surface): --materialize-pages writes a superseded_by marker readers can see ──
test("G1: --materialize-pages writes a plain-string superseded_by marker; content-binding stays intact", () => {
  const w = ws({ "m.md": MSN, "n.md": NPLAIN });
  try {
    scan({ docsDir: w.dir });
    approveBound(w.dir, "N", "ADR N", "n.md");
    approveBound(w.dir, "M", "ADR M", "m.md"); // M supersedes N → effective
    fsck({ docsDir: w.dir, write: true, materializePages: true });
    const nRaw = readFileSync(join(w.dir, "n.md"), "utf8");
    assert.match(nRaw, /^superseded_by: ADR M$/m, "the reader can now see 'superseded by ADR M'");
    assert.doesNotMatch(nRaw, /^effective_status:\s*canonical/m, "a superseded page is not stamped canonical");
    // the marker is a plain string, NOT a [[wiki-link]] → it must not mint a phantom superseded_by edge
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    assert.ok(!model.edges.some((e) => e.edgeType === "superseded_by"), "the derived marker must not become an edge");
    // content-binding: materializing the derived marker (in NON_SEMANTIC_KEYS) must NOT flag N stale-approval
    const r2 = fsck({ docsDir: w.dir });
    assert.ok(!r2.findings.some((f) => f.kind === "stale-approval" && f.uid === "N"), "superseded_by is non-semantic — approval stays bound");
    assert.deepEqual(r2.superseded.get("N"), ["M"], "still superseded after materialize (idempotent)");
  } finally { w.cleanup(); }
});

test("G1-hardening: a page carrying superseded_by that is NOT actually superseded → stale-superseded-marker (advisory)", () => {
  // a page with a leftover/spurious superseded_by marker (nothing actually supersedes it) — parity with
  // effective_status: recall's fsck cross-check must be able to distrust it. Advisory (does not block).
  const w = ws({ "p.md": "---\nid: P\ntitle: ADR P\nstatus: proposed\nsuperseded_by: Ghost\n---\n# ADR P\nbody ^p\n" });
  try {
    scan({ docsDir: w.dir });
    const r = fsck({ docsDir: w.dir });
    assert.ok(r.findings.some((f) => f.kind === "stale-superseded-marker" && f.uid === "P"), "the spurious marker is flagged");
    assert.equal(r.ok, true);
  } finally { w.cleanup(); }
});

// (No empty-title test: loadCorpus rejects a titleless page outright, so the `|| u` fallback in
// supersededTitles is unreachable belt-and-suspenders, not a reachable bug — verified, Codex's diff-only
// MEDIUM was a false positive.)

test("G1: --materialize-pages authoritatively REMOVES a spurious/hand-authored superseded_by (spoof-proof)", () => {
  const w = ws({ "k.md": "---\nid: K\ntitle: ADR K\nsuperseded_by: Somebody\n---\n# ADR K\nbody ^k\n" });
  try {
    scan({ docsDir: w.dir });
    approveBound(w.dir, "K", "ADR K", "k.md"); // K is canonical and NOT superseded — the marker is a lie
    fsck({ docsDir: w.dir, write: true, materializePages: true });
    assert.doesNotMatch(readFileSync(join(w.dir, "k.md"), "utf8"), /^superseded_by:/m, "a not-superseded page has its spurious marker stripped");
  } finally { w.cleanup(); }
});
