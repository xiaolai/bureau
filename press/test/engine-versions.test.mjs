// WI-V — git-backed versioned board: build --at, log diff, named snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { buildAtRef, logDiff, snapshotCreate, readSnapshots, resolveSnapshotOrRef } from "../src/engine/versions.mjs";
import { buildSite } from "../src/build.mjs";

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "wb-ver-"));
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: ["ignore", "ignore", "ignore"] });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  return {
    root, dir,
    write: (rel, body) => writeFileSync(join(dir, rel), body),
    commit: (msg) => { g("add", "-A"); g("commit", "-q", "-m", msg); return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const U = (def = "def") => `---\nid: U\ntitle: Upstream\n---\n# Upstream\n${def} ^u\n`;
const DOWN = "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\" }\n---\n# Downstream\nclaim ^d\n";

test("versions: logDiff reports the decision-log events added between two commits", () => {
  const r = gitRepo();
  try {
    r.write("u.md", U()); r.write("d.md", DOWN);
    scan({ docsDir: r.dir });
    const c1 = r.commit("v1");
    r.write("u.md", U("def CHANGED"));
    scan({ docsDir: r.dir });
    const c2 = r.commit("v2");
    const d = logDiff({ root: r.root, refA: c1, refB: c2, docsDirAbs: r.dir });
    assert.equal(d.newEvents, 1);
    assert.equal(d.by.edit.length, 1);
    assert.equal(d.by.edit[0].span, "^u");
  } finally { r.cleanup(); }
});

test("versions: build --at renders the board AS OF a past commit (ignores later working-tree edits)", () => {
  const r = gitRepo();
  try {
    r.write("u.md", U()); r.write("d.md", DOWN);
    r.write("_config.json", '{"meta":{"title":"T","home":"Upstream"}}');
    scan({ docsDir: r.dir });
    const c1 = r.commit("v1");
    r.write("u.md", U("LATER EDIT — must not appear in the c1 board")); // uncommitted, post-c1
    const out = join(r.root, "board-at-c1");
    const res = buildAtRef({ root: r.root, ref: c1, docsDirAbs: r.dir, outDirAbs: out, now: null, buildSite });
    assert.ok(existsSync(join(out, "index.html")));
    assert.equal(res.commit, c1);
    // no leaked worktree
    assert.doesNotMatch(execFileSync("git", ["-C", r.root, "worktree", "list"], { encoding: "utf8" }), /board-at-c1|bureau-at-/);
  } finally { r.cleanup(); }
});

test("versions: snapshot create pins {commit, seq}; the name resolves to its commit; dupes rejected", () => {
  const r = gitRepo();
  try {
    r.write("u.md", U()); scan({ docsDir: r.dir });
    const c1 = r.commit("v1");
    const e = snapshotCreate({ root: r.root, docsDirAbs: r.dir, name: "rc1", note: "release candidate" });
    assert.equal(e.commit, c1);
    assert.equal(e.seq, 1); // one introduce event
    assert.equal(readSnapshots(r.dir).length, 1);
    assert.equal(resolveSnapshotOrRef({ root: r.root, docsDirAbs: r.dir, ref: "rc1" }), c1);
    assert.throws(() => snapshotCreate({ root: r.root, docsDirAbs: r.dir, name: "rc1" }), /already exists/);
    assert.throws(() => snapshotCreate({ root: r.root, docsDirAbs: r.dir, name: "bad name!" }), /must match/);
  } finally { r.cleanup(); }
});
