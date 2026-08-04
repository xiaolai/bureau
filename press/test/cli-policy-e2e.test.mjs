// End-to-end CLI tests for the trust-authority policy. The other policy tests call engine modules
// directly, so none of them exercises the WRITE boundary — the CLI is where `--by` enters the log and
// where `resolve` builds its event. A bypass here would have left every engine test green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { reviewDigest } from "../src/engine/review-digest.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gazette.mjs");

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-cli-policy-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
// run the BUNDLED cli (what actually ships) and capture status + output together
function gz(dir, args) {
  try { return { code: 0, out: execFileSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") }; }
}
const policy = (dir, tp) => writeFileSync(join(dir, "_config.json"), JSON.stringify({ trust_policy: tp }));
// spawnSync captures BOTH streams (the --all warning goes to stderr) and its piped stdin is not a TTY.
function gzBoth(dir, args) {
  const r = spawnSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

const CANON = "---\nid: P\ntitle: Pee\ntrust: canonical\n---\n# Pee\nx ^p\n";
const A = "---\nid: A\ntitle: Ay\ncontradicts: \"[[Bee]]\"\n---\n# Ay\nclaim a ^a\n";
const B = "---\nid: B\ntitle: Bee\n---\n# Bee\nclaim b ^b\n";

test("cli e2e: an `invariant` approval is blocked under the default policy and accepted when opted in", () => {
  const w = ws({ "p.md": CANON });
  try {
    gz(w.dir, ["scan"]);
    assert.equal(gz(w.dir, ["approve", "Pee", "--by", "invariant"]).code, 0);
    const blocked = gz(w.dir, ["fsck"]);
    assert.match(blocked.out, /unauthorized-canonical/);
    assert.equal(blocked.code, 1); // CI goes red

    policy(w.dir, { approve: ["invariant", "human"] });
    const allowed = gz(w.dir, ["fsck"]);
    assert.doesNotMatch(allowed.out, /unauthorized/);
    assert.equal(allowed.code, 0);
  } finally { w.cleanup(); }
});

test("cli e2e: `resolve` refuses a pair that does not currently contradict each other", () => {
  // without this, a resolution could be pre-seeded for any two pages; if a `contradicts:` edge were
  // added later the stale event resolved it automatically, with no review.
  const w = ws({ "p.md": CANON, "b.md": B });
  try {
    gz(w.dir, ["scan"]);
    const r = gz(w.dir, ["resolve", "Pee", "Bee", "--winner", "Pee", "--by", "human"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /do not declare a `contradicts:` edge/);
  } finally { w.cleanup(); }
});

test("cli e2e: decision commands refuse without --by (no silent human authority — ADR-0004)", () => {
  const w = ws({ "p.md": CANON, "b.md": B });
  try {
    gz(w.dir, ["scan"]);
    for (const args of [["approve", "Pee"], ["reject", "Pee"], ["confirm", "Pee"], ["resolve", "Pee", "Bee", "--winner", "Pee"]]) {
      const r = gz(w.dir, args);
      assert.notEqual(r.code, 0, args[0] + " must refuse without --by");
      assert.match(r.out, /requires --by/, args[0] + " names the --by requirement");
    }
    assert.equal(gz(w.dir, ["approve", "Pee", "--by", "human"]).code, 0, "with --by it proceeds");
  } finally { w.cleanup(); }
});

test("cli e2e: `approve` is content-bound — logs the reviewed page digest (not unbound)", () => {
  const w = ws({ "p.md": CANON, "b.md": B });
  try {
    gz(w.dir, ["scan"]);
    const ap = gz(w.dir, ["approve", "Pee", "--by", "human"]);
    assert.equal(ap.code, 0);
    // the projection message (Phase 3) — accurate: points at effective_status / materialize, NOT `report`
    assert.match(ap.out, /is a PROJECTION/i);
    assert.match(ap.out, /effective_status/);
    assert.doesNotMatch(ap.out, /gazette report/);
    const log = readFileSync(join(w.dir, "_log.jsonl"), "utf8");
    assert.match(log, /"type":"approve"/, "an approve event was logged");
    assert.match(log, /"hash":"bureau-page-v1:[0-9a-f]{64}"/, "the CLI approval carries a content hash");
  } finally { w.cleanup(); }
});

test("cli e2e: `legacy-migrate` grandfathers an unbacked canonical → advisory legacy-canonical (voided on edit)", () => {
  const w = ws({ "p.md": CANON, "b.md": B }); // CANON: id P, trust: canonical, NO approve → unbacked
  try {
    gz(w.dir, ["scan"]);
    const before = gz(w.dir, ["fsck"]);
    assert.equal(before.code, 1, "authored canonical with no approve BLOCKS fsck");
    assert.match(before.out, /unbacked-canonical/);
    assert.match(gz(w.dir, ["legacy-migrate", "--check"]).out, /1 page\(s\) WOULD be grandfathered/);
    assert.equal(gz(w.dir, ["legacy-migrate"]).code, 0);
    assert.match(readFileSync(join(w.dir, "_legacy-canonical.json"), "utf8"), /"P": "bureau-page-v1:/);
    const after = gz(w.dir, ["fsck"]);
    assert.equal(after.code, 0, "grandfathered → advisory legacy-canonical → fsck ok");
    assert.match(after.out, /legacy-canonical/);
    assert.doesNotMatch(after.out, /unbacked-canonical/);
    writeFileSync(join(w.dir, "p.md"), "---\nid: P\ntitle: Pee\ntrust: canonical\n---\n# Pee\nEDITED ^p\n");
    const edited = gz(w.dir, ["fsck"]);
    assert.equal(edited.code, 1, "an edit voids the grandfather → unbacked (blocking) again");
    assert.match(edited.out, /unbacked-canonical/);
  } finally { w.cleanup(); }
});

test("cli e2e: `fsck --materialize-pages` caches effective_status without overwriting authored status (--check refuses)", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: Pee\nstatus: proposed\n---\n# Pee\nx ^p\n" });
  try {
    gz(w.dir, ["scan"]);
    assert.equal(gz(w.dir, ["approve", "Pee", "--by", "human"]).code, 0);
    const mat = gz(w.dir, ["fsck", "--materialize-pages"]);
    assert.equal(mat.code, 0);
    assert.match(mat.out, /effective_status materialized on 1 page/);
    const text = readFileSync(join(w.dir, "p.md"), "utf8");
    assert.match(text, /^status: proposed$/m, "authored status is NOT overwritten (Decision C)");
    assert.match(text, /^effective_status: canonical$/m, "the derived effective tier is cached");
    // the source-mutating flag must refuse the read-only --check
    const bad = gz(w.dir, ["fsck", "--materialize-pages", "--check"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /can't combine with --check/);
  } finally { w.cleanup(); }
});

test("cli e2e: `review` lists the typed queue upstream-first; --next truncates", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Upstream\nstatus: proposed\n---\n# Upstream\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Downstream\nstatus: proposed\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"x\" }\n---\n# Downstream\nclaim ^d\n",
  });
  try {
    gz(w.dir, ["scan"]);
    const r = gz(w.dir, ["review"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /2 item\(s\) — 2 approve/);
    assert.ok(r.out.indexOf("Upstream") < r.out.indexOf("Downstream"), "the depended-on page is listed first");
    const n1 = gz(w.dir, ["review", "--next", "1"]);
    assert.match(n1.out, /1 more/);
    assert.notEqual(gz(w.dir, ["review", "--next", "0"]).code, 0); // rejects non-positive
  } finally { w.cleanup(); }
});

test("cli e2e: `approve --from` applies a manifest as one commit-gated batch; drift/no-digest/missing-reason refuse", () => {
  const w = ws({
    "p.md": "---\nid: P\ntitle: Pea\nstatus: proposed\n---\n# Pea\nclaim ^p\n",
    "q.md": "---\nid: Q\ntitle: Que\nstatus: proposed\n---\n# Que\nclaim ^q\n",
  });
  const mpath = join(w.dir, "..", "m.json");
  try {
    gz(w.dir, ["scan"]);
    const pDigest = reviewDigest({ raw: readFileSync(join(w.dir, "p.md"), "utf8"), uid: "P", title: "Pea" });
    const qDigest = reviewDigest({ raw: readFileSync(join(w.dir, "q.md"), "utf8"), uid: "Q", title: "Que" });
    // (a) approve BOTH → commits as one bracketed batch with a stable batch_id
    writeFileSync(mpath, JSON.stringify({ approve: [{ page: "Pea", digest: pDigest }, { page: "Que", digest: qDigest }] }));
    const ok = gz(w.dir, ["approve", "--from", mpath, "--by", "human"]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /2 approved, 0 rejected/);
    const log = readFileSync(join(w.dir, "_log.jsonl"), "utf8");
    assert.match(log, /"type":"batch-begin"/);
    assert.match(log, /"type":"batch-commit"/);
    assert.match(log, /"batch_id":"batch-[0-9a-f]{16}"/);
    assert.equal(gz(w.dir, ["fsck"]).code, 0, "the committed batch leaves the canon clean");
    // (a2) rerunning the identical manifest is harmless — re-approves in a fresh bracket, same canonical
    // state, canon stays clean (effect-idempotent; a random id keeps crash-recovery working)
    const rerun = gz(w.dir, ["approve", "--from", mpath, "--by", "human"]);
    assert.equal(rerun.code, 0, rerun.out);
    assert.match(rerun.out, /2 approved, 0 rejected/);
    assert.equal(gz(w.dir, ["fsck"]).code, 0, "still clean after a rerun");
    // (a3) rejecting an APPROVED page revokes it (auto-scoped to the active approval)
    writeFileSync(mpath, JSON.stringify({ reject: [{ page: "Que", because: "superseded by ADR-0010" }] }));
    const rej = gz(w.dir, ["approve", "--from", mpath, "--by", "human"]);
    assert.equal(rej.code, 0, rej.out);
    assert.match(rej.out, /0 approved, 1 rejected/);
    // (a4) rejecting a NOT-approved page is refused — nothing to revoke, never a phantom "rejected"
    writeFileSync(mpath, JSON.stringify({ reject: [{ page: "Que", because: "again" }] }));
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /not currently approved/);
    // (b) a bare title (no digest) → refused, zero new events
    const before = readFileSync(join(w.dir, "_log.jsonl"), "utf8");
    writeFileSync(mpath, JSON.stringify({ approve: ["Pea"] }));
    const noDigest = gz(w.dir, ["approve", "--from", mpath, "--by", "human"]);
    assert.notEqual(noDigest.code, 0);
    assert.match(noDigest.out, /needs a "digest"/);
    assert.equal(readFileSync(join(w.dir, "_log.jsonl"), "utf8"), before, "a rejected manifest writes nothing");
    // (c) a stale digest → refused
    writeFileSync(mpath, JSON.stringify({ approve: [{ page: "Pea", digest: "bureau-page-v1:" + "0".repeat(64) }] }));
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /digest mismatch/);
    // (d) a reject with no `because` → refused
    writeFileSync(mpath, JSON.stringify({ reject: [{ page: "Que" }] }));
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /needs a "because"/);
    // (e) a page in both lists → refused
    writeFileSync(mpath, JSON.stringify({ approve: [{ page: "Pea", digest: pDigest }], reject: [{ page: "Pea", because: "x" }] }));
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /both lists|twice/);
    // (f) an invalid reject scope value → refused; a non-array half → refused (never silently dropped)
    writeFileSync(mpath, JSON.stringify({ reject: [{ page: "Que", because: "x", approval_seq: "bad" }] }));
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /approval_seq must be/);
    writeFileSync(mpath, JSON.stringify({ approve: "notanarray" }));
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /`approve` must be an array/);
    writeFileSync(mpath, JSON.stringify({ approve: null, reject: [{ page: "Que", because: "x" }] })); // present-but-null half
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /`approve` must be an array/);
    // mutual exclusivity with a positional title
    assert.match(gz(w.dir, ["approve", "Pea", "--from", mpath, "--by", "human"]).out, /ONE of/);
  } finally { w.cleanup(); rmSync(mpath, { force: true }); }
});

test("cli e2e: `review --json` emits per-page digests; a manifest seeded from them applies via --from (drift refused)", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: Pea\nstatus: proposed\n---\n# Pea\nclaim ^p\n" });
  const mpath = join(w.dir, "..", "m2.json");
  try {
    gz(w.dir, ["scan"]);
    const item = JSON.parse(gz(w.dir, ["review", "--json"]).out).items.find((i) => i.uids[0] === "P");
    assert.equal(item.kind, "approve");
    assert.notEqual(gz(w.dir, ["review", "--json", "--next", "0"]).code, 0); // --next is validated even with --json
    assert.match(item.digest, /^bureau-page-v1:[0-9a-f]{64}$/, "an approvable item carries a content digest");
    // seed a manifest straight from the emitted digest → applies
    writeFileSync(mpath, JSON.stringify({ approve: [{ page: "Pea", digest: item.digest }] }));
    assert.equal(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).code, 0);
    // edit the page → the seeded digest is now stale → --from refuses (the review→apply TOCTOU is closed)
    writeFileSync(join(w.dir, "p.md"), "---\nid: P\ntitle: Pea\nstatus: proposed\n---\n# Pea\nEDITED ^p\n");
    assert.match(gz(w.dir, ["approve", "--from", mpath, "--by", "human"]).out, /digest mismatch/);
  } finally { w.cleanup(); rmSync(mpath, { force: true }); }
});

test("cli e2e: a batch by an authority the policy does not accept is refused up front (nothing committed)", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: Pea\nstatus: proposed\n---\n# Pea\nclaim ^p\n" });
  const mpath = join(w.dir, "..", "m3.json");
  try {
    gz(w.dir, ["scan"]);
    const d = reviewDigest({ raw: readFileSync(join(w.dir, "p.md"), "utf8"), uid: "P", title: "Pea" });
    writeFileSync(mpath, JSON.stringify({ approve: [{ page: "Pea", digest: d }] }));
    const bad = gz(w.dir, ["approve", "--from", mpath, "--by", "llm"]); // default policy is human-only
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /not an accepted approve authority/);
    assert.doesNotMatch(readFileSync(join(w.dir, "_log.jsonl"), "utf8"), /"type":"approve"/, "an inert batch is never committed");
  } finally { w.cleanup(); rmSync(mpath, { force: true }); }
});

test("cli e2e: `approve --all` warns to stderr, proceeds non-interactively, excludes conflicts, batches", () => {
  const w = ws({
    "p.md": "---\nid: P\ntitle: Pea\nstatus: proposed\n---\n# Pea\nclaim ^p\n",
    "u.md": "---\nid: U\ntitle: You\nstatus: proposed\n---\n# You\nclaim ^u\n",
    "c.md": "---\nid: C\ntitle: See\nstatus: proposed\ncontradicts: \"[[Dee]]\"\n---\n# See\nclaim ^c\n",
    "d.md": "---\nid: D\ntitle: Dee\nstatus: proposed\n---\n# Dee\nclaim ^d\n",
  });
  try {
    gz(w.dir, ["scan"]);
    const r = gzBoth(w.dir, ["approve", "--all", "--by", "human"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /BULK APPROVE — 2 page/, "Pea + You are approvable; the contested pair is not");
    assert.match(r.err, /\[approve\]/, "each page shows its work-item kind in the warning");
    assert.match(r.err, /HUMAN read and vouched/, "authority-conditioned warning (human)");
    assert.match(r.err, /excluded.*resolve/i, "the contested See×Dee pair is excluded, not approved");
    assert.match(r.out, /2 approved/);
    const log = readFileSync(join(w.dir, "_log.jsonl"), "utf8");
    assert.match(log, /"mode":"all"/);
    assert.match(log, /"type":"batch-commit"/);
    // a second run has nothing approvable (Pea/You now canonical; See/Dee still contested)
    assert.match(gzBoth(w.dir, ["approve", "--all", "--by", "human"]).out, /nothing to bulk-approve/);
    // mutually exclusive with a title / --from
    assert.match(gz(w.dir, ["approve", "Pea", "--all", "--by", "human"]).out, /ONE of/);
  } finally { w.cleanup(); }
});

test("cli e2e: `approve --all` conditions its warning on the authority (machine ≠ human)", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: Pea\nstatus: proposed\n---\n# Pea\nclaim ^p\n" });
  try {
    gz(w.dir, ["scan"]);
    policy(w.dir, { approve: ["invariant", "human"] }); // accept a machine authority so the run is legitimate
    const r = gzBoth(w.dir, ["approve", "--all", "--by", "invariant"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Recorded under `invariant`/, "machine authority → NOT the 'a human vouched' text");
    assert.doesNotMatch(r.err, /HUMAN read and vouched/);
  } finally { w.cleanup(); }
});

test("cli e2e: the `resolve` policy gates a machine resolution end to end", () => {
  const w = ws({ "a.md": A, "b.md": B });
  try {
    gz(w.dir, ["scan"]);
    assert.equal(gz(w.dir, ["resolve", "Ay", "Bee", "--winner", "Ay", "--by", "llm"]).code, 0);
    const blocked = gz(w.dir, ["fsck"]);
    assert.match(blocked.out, /unauthorized-resolve/);
    assert.equal(blocked.code, 1);

    policy(w.dir, { resolve: ["llm", "human"] });
    assert.equal(gz(w.dir, ["fsck"]).code, 0);
  } finally { w.cleanup(); }
});

test("cli e2e: a machine confirmation does not cut an edge off under the default policy", () => {
  const UP = "---\nid: U\ntitle: Upstream\n---\n# Upstream\nthe def ^u\n";
  const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\", because: \"uses\" }\n---\n# Downstream\nthe claim ^d\n";
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    gz(w.dir, ["scan"]);
    gz(w.dir, ["confirm", "Downstream", "--by", "invariant"]);
    const g = gz(w.dir, ["gate"]);
    assert.match(g.out, /needs-review/);                       // the machine confirm did not count
    assert.match(g.out, /confirm-edge authorities: \[human\]/); // and the board says why

    policy(w.dir, { "confirm-edge": ["invariant"] });
    assert.doesNotMatch(gz(w.dir, ["gate"]).out, /needs-review/); // honored once accepted
  } finally { w.cleanup(); }
});

test("cli e2e: `review` POSIX-escapes an untrusted page title in the suggested command (no shell injection)", () => {
  const w = ws({ "p.md": "---\nid: P\ntitle: $(touch pwned)\nstatus: proposed\n---\n# X\nclaim ^p\n" });
  try {
    gz(w.dir, ["scan"]);
    const r = gz(w.dir, ["review"]);
    assert.match(r.out, /approve '\$\(touch pwned\)'/, "the title is single-quoted, inert if pasted");
    assert.doesNotMatch(r.out, /approve "\$\(/, "never bare inside double quotes");
  } finally { w.cleanup(); }
});

test("cli e2e: `ledger uncompiled` defaults to real logbook sessions; mark-compiled rejects a non-session id", () => {
  const w = ws({});
  try {
    const lb = join(w.dir, "logbook"); mkdirSync(lb, { recursive: true });
    writeFileSync(join(lb, "s1.md"), "---\ntitle: t\nstatus: logbook\nsession: sess-aaa\n---\nbody\n");
    writeFileSync(join(lb, "s2.md"), "---\ntitle: t\nstatus: logbook\nsession: sess-bbb\n---\nbody\n");
    writeFileSync(join(lb, "founding.md"), "---\nid: pg-min-1\ntitle: t\nstatus: logbook\n---\nno session field\n");
    writeFileSync(join(lb, "crlf.md"), "---\r\ntitle: t\r\nstatus: logbook\r\nsession: sess-crlf\r\n---\r\nbody\r\n"); // CRLF frontmatter
    writeFileSync(join(lb, "evil.md"), "---\ntitle: t\nstatus: logbook\nsession: EVIL[31mX\n---\nbody\n"); // control-char session
    const u = gz(w.dir, ["ledger", "uncompiled"]); // bare → all logbook sessions, NOT "(all compiled)"
    assert.match(u.out, /sess-aaa/); assert.match(u.out, /sess-bbb/);
    assert.match(u.out, /sess-crlf/, "CRLF-delimited frontmatter is parsed, not ignored");
    assert.doesNotMatch(u.out, /EVIL/, "a control-char session id is excluded (no terminal-injection)");
    assert.doesNotMatch(u.out, /founding|pg-min/, "a minute with no session: is not a session");
    assert.equal(gz(w.dir, ["ledger", "mark-compiled", "sess-aaa"]).code, 0);
    const u2 = gz(w.dir, ["ledger", "uncompiled"]);
    assert.doesNotMatch(u2.out, /sess-aaa/); assert.match(u2.out, /sess-bbb/);
    const bad = gz(w.dir, ["ledger", "mark-compiled", "canon"]); // the stray-"canon" bug
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /no logbook session matches/);
  } finally { w.cleanup(); }
});

test("cli e2e: a malformed trust_policy fails loud rather than silently defaulting", () => {
  const w = ws({ "p.md": CANON });
  try {
    gz(w.dir, ["scan"]);
    writeFileSync(join(w.dir, "_config.json"), JSON.stringify({ trust_policy: { approve: ["robot"] } }));
    const r = gz(w.dir, ["fsck"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /unknown authority/);
  } finally { w.cleanup(); }
});
