// ADR-0003 — external workspaces: the versioned-board ops must locate git from the WORKSPACE path,
// never from process.cwd(). These tests run with cwd = press/ (inside the bureau repo), yet operate
// on a SEPARATE temp repo — so any reliance on process.cwd() as the git root would fail here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { buildAtRef, logDiff, snapshotCreate, gitRootFor } from "../src/engine/versions.mjs";
import { buildSite } from "../src/build.mjs";

// The EXTERNAL layout: a git root (~/bureaus/PROJ) with the workspace as a CHILD (PROJ/canon).
// realpath the root so it matches what `git rev-parse --show-toplevel` returns on macOS (/var → /private/var).
function repoWithChildWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-ext-")));
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

test("ADR-0003: gitRootFor resolves the repo from the WORKSPACE path, independent of process.cwd()", () => {
  const r = repoWithChildWorkspace();
  try {
    assert.notEqual(realpathSync(process.cwd()), r.root);   // the caller stands in a DIFFERENT repo
    assert.equal(gitRootFor(r.dir), r.root);                 // nested child → its own repo's top-level
    assert.equal(gitRootFor(r.root), r.root);                // the root itself → itself
  } finally { r.cleanup(); }
});

test("ADR-0003: snapshot + diff operate on the workspace's OWN repo from a foreign cwd (root = gitRootFor(ws))", () => {
  const r = repoWithChildWorkspace();
  try {
    r.write("u.md", U()); scan({ docsDir: r.dir }); const c1 = r.commit("v1");
    r.write("u.md", U("def CHANGED")); scan({ docsDir: r.dir }); const c2 = r.commit("v2");
    const root = gitRootFor(r.dir); // derived from the workspace, NOT process.cwd()
    // the snapshot pins the WORKSPACE repo's HEAD (c2) — proof the right repo was used despite foreign cwd
    const entry = snapshotCreate({ root, docsDirAbs: r.dir, name: "v2", digest: null });
    assert.equal(entry.commit, c2);
    const d = logDiff({ root, refA: c1, refB: c2, docsDirAbs: r.dir });
    assert.equal(d.newEvents, 1);
    assert.equal(d.by.edit[0].span, "^u");
  } finally { r.cleanup(); }
});

test("ADR-0003: build --at renders the workspace board from a foreign cwd", () => {
  const r = repoWithChildWorkspace();
  try {
    r.write("u.md", U()); r.write("_config.json", '{"meta":{"title":"T","home":"Upstream"}}');
    scan({ docsDir: r.dir }); const c1 = r.commit("v1");
    const out = join(r.root, "board-at-c1");
    const res = buildAtRef({ root: gitRootFor(r.dir), ref: c1, docsDirAbs: r.dir, outDirAbs: out, now: null, buildSite });
    assert.ok(existsSync(join(out, "index.html")));
    assert.equal(res.commit, c1);
  } finally { r.cleanup(); }
});

test("ADR-0003 (WI-1.2): a workspace that IS the git top-level fails with an actionable 'nest under a git root' error", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-top-")));
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
    writeFileSync(join(root, "u.md"), U());
    scan({ docsDir: root });
    g("add", "-A"); g("commit", "-q", "-m", "v1");
    // workspace === git top-level (rel === "") → the actionable message, not the generic "outside" one
    assert.throws(
      () => snapshotCreate({ root: gitRootFor(root), docsDirAbs: root, name: "v1", digest: null }),
      /nest it under a git root/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ADR-0003: gitRootFor throws a clear error for a path not inside any git repo", () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "wb-nogit-")));
  try {
    assert.throws(() => gitRootFor(d), /not inside a git repository/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
