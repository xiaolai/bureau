// trust-authority policy — which authority CLASSES may satisfy each gated decision (ADR-0001
// extension). Default is human-only (byte-invisible on all-human data); a workspace opts a machine
// authority in via `_config.json`.`trust_policy`. Covered: the classifier, the loader/validator, the
// two fsck findings, and the freshness teeth in the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { fsck, buildDerived, derivedDigest } from "../src/engine/fsck.mjs";
import { computeGate } from "../src/engine/gate.mjs";
import { report, renderMetricsText } from "../src/engine/metrics.mjs";
import { projectTimeline } from "../src/engine/telemetry.mjs";
import { liveFreshness } from "../src/engine/live.mjs";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { logPath, readLog, appendEvent } from "../src/engine/log.mjs";
import { conflictKey, legacyConflictKey } from "../src/engine/state.mjs";
import { authorityClass, isAuthorized, validatePolicy, loadPolicy, DEFAULT_POLICY, isDefaultPolicy, acceptsMachine } from "../src/engine/policy.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-policy-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const UP = "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe def ^u\n";
const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses\" }\n---\n# Downstream\nthe claim ^d\n";
const CANON = "---\nid: P\ntitle: Pee\ntrust: canonical\n---\n# Pee\nx ^p\n";

// ---- the classifier ----
test("authorityClass: machine names are reserved; a person / absent / malformed `by` is human", () => {
  assert.equal(authorityClass("scan"), "scan");
  assert.equal(authorityClass("invariant"), "invariant");
  assert.equal(authorityClass("llm"), "llm");
  assert.equal(authorityClass("xiaolai"), "human"); // a username → human (zero log migration)
  assert.equal(authorityClass(""), "human");
  assert.equal(authorityClass(undefined), "human"); // legacy event with no `by`
  assert.equal(authorityClass(null), "human");
});

// ---- the loader / validator ----
test("validatePolicy: default is human-only; a partial policy keeps the human default elsewhere", () => {
  assert.deepEqual(DEFAULT_POLICY.approve, ["human"]);
  const p = validatePolicy({ approve: ["invariant", "human"] });
  assert.deepEqual(p.approve, ["invariant", "human"]);
  assert.deepEqual(p["confirm-edge"], ["human"]); // untouched → still the default
  assert.equal(validatePolicy(undefined), DEFAULT_POLICY); // absent key → default
  // an EXPLICIT null is malformed, not "absent" — silently defaulting would let a restrictive
  // policy be replaced by null and quietly fall back to accepting humans.
  assert.throws(() => validatePolicy(null), /trust_policy is null/);
});

test("DEFAULT_POLICY is deep-frozen — a stray push cannot open the gate process-wide", () => {
  assert.throws(() => { DEFAULT_POLICY.approve.push("llm"); }, TypeError);
  assert.deepEqual(DEFAULT_POLICY.approve, ["human"]);
  const p = validatePolicy({ approve: ["invariant"] });
  assert.throws(() => { p.approve.push("llm"); }, TypeError);
});

test("isAuthorized: corrupt entries authorize nothing; absent entries fall back to the strictest default", () => {
  // a PRESENT non-array is corrupt data → authorizes nothing. ("not-llm".includes("llm") is true, so
  // a raw string would otherwise substring-match a machine authority straight through.)
  assert.equal(isAuthorized({ approve: "not-llm" }, "approve", "llm"), false);
  assert.equal(isAuthorized({ approve: "human" }, "approve", "human"), false); // even when it "looks" right
  assert.equal(isAuthorized({ approve: {} }, "approve", "human"), false);
  // an ABSENT/null entry falls back to the human-only DEFAULT — strict, but not a lockout: refusing
  // every human approval over a config typo would be a denial of service, not a safer failure.
  assert.equal(isAuthorized({ approve: null }, "approve", "human"), true);
  assert.equal(isAuthorized({ approve: null }, "approve", "invariant"), false); // …and still rejects machines
  assert.equal(isAuthorized({}, "approve", "invariant"), false);
});

test("validatePolicy: an unknown decision or authority is a loud error, never a silent drop", () => {
  assert.throws(() => validatePolicy({ approv: ["human"] }), /unknown decision/);
  assert.throws(() => validatePolicy({ approve: ["robot"] }), /unknown authority/);
  assert.throws(() => validatePolicy({ approve: [] }), /non-empty array/);
  assert.throws(() => validatePolicy({ approve: "human" }), /non-empty array/);
});

test("loadPolicy: absent config and a config without trust_policy both yield the human-only default", () => {
  const w = ws({ "u.md": UP });
  try {
    assert.equal(loadPolicy(w.dir), DEFAULT_POLICY); // no _config.json
    writeFileSync(join(w.dir, "_config.json"), JSON.stringify({ meta: { title: "X" } }));
    assert.equal(loadPolicy(w.dir), DEFAULT_POLICY); // config present, no trust_policy
    writeFileSync(join(w.dir, "_config.json"), JSON.stringify({ trust_policy: { approve: ["invariant"] } }));
    assert.deepEqual(loadPolicy(w.dir).approve, ["invariant"]);
  } finally { w.cleanup(); }
});

test("isAuthorized: the one predicate the gate and fsck consult", () => {
  assert.equal(isAuthorized(DEFAULT_POLICY, "approve", "xiaolai"), true);   // human ∈ [human]
  assert.equal(isAuthorized(DEFAULT_POLICY, "approve", "invariant"), false); // invariant ∉ [human]
  assert.equal(isAuthorized(validatePolicy({ approve: ["invariant"] }), "approve", "invariant"), true);
});

// ---- fsck: the canonical authority finding ----
test("fsck: a canonical approved by `invariant` is unauthorized under the human-only default", () => {
  const w = ws({ "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "invariant" });
    const r = fsck({ docsDir: w.dir });
    assert.ok(r.findings.some((f) => f.kind === "unauthorized-canonical" && f.uid === "P" && f.by === "invariant"));
    assert.equal(r.ok, false); // blocking — CI goes red
  } finally { w.cleanup(); }
});

test("fsck: the SAME invariant-approved canonical is clean once the policy accepts `invariant`", () => {
  const w = ws({ "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "invariant" });
    const r = fsck({ docsDir: w.dir, policy: validatePolicy({ approve: ["invariant"] }) });
    assert.ok(!r.findings.some((f) => f.kind === "unauthorized-canonical" || f.kind === "unbacked-canonical"));
  } finally { w.cleanup(); }
});

test("fsck: a human-approved canonical stays clean under the default (backward compatible)", () => {
  const w = ws({ "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "xiaolai" });
    const r = fsck({ docsDir: w.dir });
    assert.ok(!r.findings.some((f) => f.kind.startsWith("unauthorized") || f.kind === "unbacked-canonical"));
  } finally { w.cleanup(); }
});

// ---- the freshness teeth: a disallowed confirmation never cuts the edge off ----
test("gate: an `invariant` confirmation is ignored under human-only, honored when the policy allows it", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const g0 = computeGate({ model, events: readLog(logPath(w.dir)) });
    const edge = g0.edges.find((e) => e.tracked && e.open && e.edgeId);
    assert.ok(edge, "Downstream's edge should start open (never confirmed)");
    assert.equal(g0.freshness.get("D"), "needs-review");

    // confirm the edge by an INVARIANT authority
    appendEvent(logPath(w.dir), { type: "confirm-edge", edge: edge.edgeId, verdict_key: edge.verdictKey, by: "invariant" });
    const events = readLog(logPath(w.dir));

    // human-only default → the invariant confirmation is filtered out → still needs-review
    assert.equal(computeGate({ model, events, policy: DEFAULT_POLICY }).freshness.get("D"), "needs-review");
    // policy accepts invariant → the verdict key matches → the edge cuts off → current
    assert.equal(computeGate({ model, events, policy: validatePolicy({ "confirm-edge": ["invariant"] }) }).freshness.get("D"), "current");
    // no policy (legacy path) → every confirmation counts → current, exactly as before this feature
    assert.equal(computeGate({ model, events }).freshness.get("D"), "current");
  } finally { w.cleanup(); }
});

test("fsck: an invariant-confirmed edge is flagged unauthorized-confirm under the human-only default", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const edge = computeGate({ model, events: readLog(logPath(w.dir)) }).edges.find((e) => e.tracked && e.open && e.edgeId);
    appendEvent(logPath(w.dir), { type: "confirm-edge", edge: edge.edgeId, verdict_key: edge.verdictKey, by: "invariant" });
    const r = fsck({ docsDir: w.dir });
    assert.ok(r.findings.some((f) => f.kind === "unauthorized-confirm" && f.edge === edge.edgeId && f.by === "invariant"));
    assert.equal(r.ok, false);
  } finally { w.cleanup(); }
});

// ---- the derived tier records the authority (single source of truth) ----
test("buildDerived: a REJECTED approval backs nothing — trustBy is null, not the rejected authority", () => {
  const w = ws({ "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "invariant" });
    const d = fsck({ docsDir: w.dir, write: false }).derived.decided.find((x) => x.uid === "P");
    assert.equal(d.trustBy, null);          // the rejected approval grants nothing
    assert.equal(d.trustAuthorized, false); // human-only default rejects it
    assert.equal(d.trustBacked, false);     // and it does NOT back the authored canonical
    const d2 = fsck({ docsDir: w.dir, write: false, policy: validatePolicy({ approve: ["invariant"] }) }).derived.decided.find((x) => x.uid === "P");
    assert.equal(d2.trustBy, "invariant");
    assert.equal(d2.trustAuthorized, true);
    assert.equal(d2.trustBacked, true);
  } finally { w.cleanup(); }
});

// ---- the two Critical gate bypasses the audit found ----
test("fsck: a machine approval cannot promote an authored `proposed` page to canonical", () => {
  // the bypass: authorization used to key off the AUTHORED tier, so a page authored `proposed` that an
  // unaccepted authority promoted via the log was skipped entirely and fsck stayed green.
  const w = ws({ "p.md": "---\nid: P\ntitle: Pee\ntrust: proposed\n---\n# Pee\nx ^p\n" });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "invariant" });
    const r = fsck({ docsDir: w.dir, write: false });
    assert.ok(r.findings.some((f) => f.kind === "unauthorized-canonical" && f.uid === "P" && f.by === "invariant"));
    assert.equal(r.ok, false); // must NOT stay green
    const d = r.derived.decided.find((x) => x.uid === "P");
    assert.equal(d.trust, "proposed"); // the rejected approval promoted nothing
  } finally { w.cleanup(); }
});

test("fsck: the `resolve` policy is enforced — an unaccepted authority cannot resolve a conflict", () => {
  const A = "---\nid: A\ntitle: Ay\ncontradicts: \"[[Bee]]\"\n---\n# Ay\nclaim a ^a\n";
  const B = "---\nid: B\ntitle: Bee\n---\n# Bee\nclaim b ^b\n";
  const w = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "resolve", conflict: conflictKey("A", "B"), winner: "A", by: "llm" });
    const r = fsck({ docsDir: w.dir, write: false });
    assert.ok(r.findings.some((f) => f.kind === "unauthorized-resolve" && f.by === "llm"));
    assert.equal(r.ok, false);
    const d = r.derived.decided.find((x) => x.uid === "A");
    assert.equal(d.conflict, "contested"); // the refused resolution did NOT resolve it
    // …and it DOES resolve once the policy accepts that authority
    const r2 = fsck({ docsDir: w.dir, write: false, policy: validatePolicy({ resolve: ["llm"] }) });
    assert.ok(!r2.findings.some((f) => f.kind === "unauthorized-resolve"));
    assert.equal(r2.derived.decided.find((x) => x.uid === "A").conflict, "resolved");
  } finally { w.cleanup(); }
});

test("resolve: a winner naming neither endpoint leaves the conflict contested (fail closed)", () => {
  const A = "---\nid: A\ntitle: Ay\ncontradicts: \"[[Bee]]\"\n---\n# Ay\nclaim a ^a\n";
  const B = "---\nid: B\ntitle: Bee\n---\n# Bee\nclaim b ^b\n";
  const w = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "resolve", conflict: conflictKey("A", "B"), winner: "UNRELATED", by: "human" });
    const d = fsck({ docsDir: w.dir, write: false }).derived.decided.find((x) => x.uid === "A");
    assert.equal(d.conflict, "contested"); // an orphan winner resolves nothing
  } finally { w.cleanup(); }
});

// ---- report (metrics) surfaces the policy, and its gate respects it ----
test("report: prints the trust policy and (default) marks it human-only", () => {
  const w = ws({ "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "human" });
    const r = report({ docsDir: w.dir });
    assert.deepEqual(r.policy.approve, ["human"]);
    const txt = renderMetricsText(r);
    assert.match(txt, /trust policy: approve=\[human\]/);
    assert.match(txt, /human-only default/);
  } finally { w.cleanup(); }
});

// ---- telemetry replays under the policy ----
test("projectTimeline: an invariant confirmation doesn't drain the queue under human-only", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const edge = computeGate({ model, events: readLog(logPath(w.dir)) }).edges.find((e) => e.tracked && e.open && e.edgeId);
    appendEvent(logPath(w.dir), { type: "confirm-edge", edge: edge.edgeId, verdict_key: edge.verdictKey, by: "invariant" });
    const events = readLog(logPath(w.dir));
    assert.equal(projectTimeline({ model, events, policy: DEFAULT_POLICY }).current.queueDepth, 1); // still dirty
    assert.equal(projectTimeline({ model, events, policy: validatePolicy({ "confirm-edge": ["invariant"] }) }).current.queueDepth, 0); // drained
  } finally { w.cleanup(); }
});

// ---- the board's live authority projection ----
test("liveFreshness: reports who backs each canonical page, flagging machine-backed + unauthorized", () => {
  const w = ws({ "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "invariant" });
    const corpus = loadCorpus({ docsDir: w.dir });
    const model = buildModel({ corpus });

    const a1 = liveFreshness({ corpus, docsDir: w.dir, model, policy: DEFAULT_POLICY }).authority;
    assert.equal(a1.canonical.length, 1);
    assert.equal(a1.machineBacked.length, 1);
    assert.equal(a1.machineBacked[0].by, "invariant");
    assert.equal(a1.unauthorized.length, 1); // rejected by human-only

    const a2 = liveFreshness({ corpus, docsDir: w.dir, model, policy: validatePolicy({ approve: ["invariant"] }) }).authority;
    assert.equal(a2.machineBacked.length, 1); // still machine-backed …
    assert.equal(a2.unauthorized.length, 0);  // … but now accepted
  } finally { w.cleanup(); }
});

test("authorityClass normalizes — a mistyped machine authority fails CLOSED, not to human", () => {
  // unnormalized, "Invariant"/"invariant " fell through to `human` and passed a human-only gate:
  // a machine that merely mistyped its own authority silently got human trust.
  for (const v of ["invariant", "Invariant", "INVARIANT", " invariant ", "\tinvariant\n"])
    assert.equal(authorityClass(v), "invariant", JSON.stringify(v));
  assert.equal(authorityClass(" Scan "), "scan");
  assert.equal(authorityClass("xiaolai"), "human"); // a real username is still human
  assert.equal(authorityClass("   "), "human");     // whitespace-only ⇒ absent ⇒ human
});

// ---- the committed policy is actually LOADED by the entry points (not just by loadPolicy) ----
test("fsck: enforces the workspace's committed trust_policy with NO explicit policy argument", () => {
  // loadPolicy was only tested in isolation — a threading regression that ignored the committed
  // policy would have left every other test green.
  const w = ws({ "p.md": CANON });
  try {
    writeFileSync(join(w.dir, "_config.json"), JSON.stringify({ trust_policy: { approve: ["invariant"] } }));
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "invariant" });
    const r = fsck({ docsDir: w.dir, write: false }); // no `policy` arg — must read _config.json
    assert.ok(!r.findings.some((f) => f.kind.startsWith("unauthorized")), "committed policy should accept invariant");
    assert.equal(r.derived.decided.find((x) => x.uid === "P").trustBy, "invariant");
    // and the same corpus is a violation once the committed policy no longer accepts it
    writeFileSync(join(w.dir, "_config.json"), JSON.stringify({ trust_policy: { approve: ["human"] } }));
    assert.ok(fsck({ docsDir: w.dir, write: false }).findings.some((f) => f.kind === "unauthorized-canonical"));
  } finally { w.cleanup(); }
});

test("the default policy is invisible on all-human data: omitted policy ⇒ identical derived bytes", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN, "p.md": CANON });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "xiaolai" });
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const events = readLog(logPath(w.dir));
    const legacy = buildDerived({ model, events });                          // pre-policy call shape
    const dflt = buildDerived({ model, events, policy: DEFAULT_POLICY });    // explicit default
    assert.equal(derivedDigest(legacy), derivedDigest(dflt));                // byte-for-byte equal
  } finally { w.cleanup(); }
});

// ---- conflictKey: collision-free encoding, with legacy keys still readable ----
test("conflictKey: uids containing the separator cannot forge another pair's key", () => {
  // legacy: ["A × B","C"] and ["A","B × C"] BOTH rendered "A × B × C", so resolving one resolved the other.
  assert.equal(legacyConflictKey("A × B", "C"), legacyConflictKey("A", "B × C")); // the old collision
  assert.notEqual(conflictKey("A × B", "C"), conflictKey("A", "B × C"));          // fixed
  assert.equal(conflictKey("A", "B"), conflictKey("B", "A"));                     // still order-independent
});

test("resolve: a conflict resolved under the LEGACY key encoding still reads as resolved", () => {
  const A = "---\nid: A\ntitle: Ay\ncontradicts: \"[[Bee]]\"\n---\n# Ay\nclaim a ^a\n";
  const B = "---\nid: B\ntitle: Bee\n---\n# Bee\nclaim b ^b\n";
  const w = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w.dir });
    // an event written before the encoding change
    appendEvent(logPath(w.dir), { type: "resolve", conflict: legacyConflictKey("A", "B"), winner: "A", by: "human" });
    const d = fsck({ docsDir: w.dir, write: false }).derived.decided.find((x) => x.uid === "A");
    assert.equal(d.conflict, "resolved"); // legacy key still honored — no migration needed
  } finally { w.cleanup(); }
});

// ---- the derived tier attests WHICH policy it was built under ----
test("buildDerived: a non-default policy is recorded in derived state; the default is omitted", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const model = buildModel({ corpus: loadCorpus({ docsDir: w.dir }) });
    const events = readLog(logPath(w.dir));
    assert.equal(buildDerived({ model, events, policy: DEFAULT_POLICY }).policy, undefined); // default ⇒ legacy bytes
    const marked = buildDerived({ model, events, policy: validatePolicy({ approve: ["invariant"] }) });
    assert.deepEqual(marked.policy.approve, ["invariant"]);
    // two DIFFERENT non-default policies must not share a digest just because events don't exercise them
    const other = buildDerived({ model, events, policy: validatePolicy({ resolve: ["llm"] }) });
    assert.notEqual(derivedDigest(marked), derivedDigest(other));
  } finally { w.cleanup(); }
});

test("isDefaultPolicy / acceptsMachine are per-decision and duplicate-insensitive", () => {
  assert.equal(isDefaultPolicy(validatePolicy({ approve: ["human", "human"] })), true); // dupes ≠ machine
  assert.equal(acceptsMachine(validatePolicy({ approve: ["human", "human"] }), "approve"), false);
  const cOnly = validatePolicy({ "confirm-edge": ["invariant"] });
  assert.equal(acceptsMachine(cOnly, "approve"), false); // approve stays human-only …
  assert.equal(acceptsMachine(cOnly, "confirm-edge"), true); // … only confirm accepts a machine
});

test("report: renders all three decisions and warns per-decision, not on any non-default policy", () => {
  const w = ws({ "p.md": CANON });
  try {
    writeFileSync(join(w.dir, "_config.json"), JSON.stringify({ trust_policy: { "confirm-edge": ["invariant"] } }));
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "approve", id: "P", to_trust: "canonical", by: "xiaolai" });
    const txt = renderMetricsText(report({ docsDir: w.dir }));
    assert.match(txt, /resolve=\[human\]/); // resolve was omitted entirely before
    assert.match(txt, /edge cutoffs may be machine-confirmed/);
    // approve is still human-only, so the canonical warning must NOT fire
    assert.doesNotMatch(txt, /`canonical` no longer implies a human vouched/);
  } finally { w.cleanup(); }
});

test("resolve: a LEGACY-key resolution still reports its winner and authority, not nulls", () => {
  // resolutionFor tried both encodings, but the metadata lookup used only the CURRENT key — so a
  // legacy-logged resolution resolved correctly yet came back winner:null / by:null.
  const A = "---\nid: A\ntitle: Ay\ncontradicts: \"[[Bee]]\"\n---\n# Ay\nclaim a ^a\n";
  const B = "---\nid: B\ntitle: Bee\n---\n# Bee\nclaim b ^b\n";
  const w = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "resolve", conflict: legacyConflictKey("A", "B"), winner: "A", by: "human" });
    const d = fsck({ docsDir: w.dir, write: false }).derived.decided.find((x) => x.uid === "A");
    assert.equal(d.conflict, "resolved");
    assert.equal(d.resolutions.length, 1);
    assert.equal(d.resolutions[0].winner, "A");   // was null before the fix
    assert.equal(d.resolutions[0].by, "human");   // was null before the fix
  } finally { w.cleanup(); }
});

test("conflict: a RECIPROCAL contradicts pair is ONE logical conflict, not two", () => {
  // both directions declared → conflictPartners listed the partner twice, producing duplicate
  // resolution rows and blanking the singular resolutionId.
  const A = "---\nid: A\ntitle: Ay\ncontradicts: \"[[Bee]]\"\n---\n# Ay\nclaim a ^a\n";
  const B = "---\nid: B\ntitle: Bee\ncontradicts: \"[[Ay]]\"\n---\n# Bee\nclaim b ^b\n";
  const w = ws({ "a.md": A, "b.md": B });
  try {
    scan({ docsDir: w.dir });
    appendEvent(logPath(w.dir), { type: "resolve", conflict: conflictKey("A", "B"), winner: "A", by: "human" });
    const d = fsck({ docsDir: w.dir, write: false }).derived.decided.find((x) => x.uid === "A");
    assert.equal(d.conflict, "resolved");
    assert.equal(d.resolutions.length, 1);      // was 2 — the same pair counted twice
    assert.notEqual(d.resolutionId, null);      // was blanked because the count wasn't 1
  } finally { w.cleanup(); }
});
