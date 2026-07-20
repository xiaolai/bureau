// End-to-end CLI tests for the trust-authority policy. The other policy tests call engine modules
// directly, so none of them exercises the WRITE boundary — the CLI is where `--by` enters the log and
// where `resolve` builds its event. A bypass here would have left every engine test green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
    const r = gz(w.dir, ["resolve", "Pee", "Bee", "--winner", "Pee"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /do not declare a `contradicts:` edge/);
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
