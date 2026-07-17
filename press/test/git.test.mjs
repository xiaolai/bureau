import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { deriveGit, renderTemporalHtml } from "../src/derive/git.mjs";

// Is git actually installed? Only then may we assert on its output; a genuinely absent
// git is the ONLY reason to skip — a null from deriveGit is otherwise a real regression.
function gitAvailable() {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function git(repo, args, env) {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, ...env } });
}

// A deterministic repo, independent of THIS checkout's mutable history: three commits under src/
//   c1: add src/a.md + src/b.md   c2: touch src/a.md   c3: touch src/a.md + src/b.md
// → churn a=3 b=2; a+b co-change twice (coupling 1.0); all three commits form one thread.
function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "wb-git-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  const commit = (msg, date) => { git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }); };
  writeFileSync(join(repo, "src", "a.md"), "a1\n");
  writeFileSync(join(repo, "src", "b.md"), "b1\n");
  commit("c1", "2026-06-01T00:00:00Z");
  writeFileSync(join(repo, "src", "a.md"), "a2\n");
  commit("c2", "2026-06-02T00:00:00Z");
  writeFileSync(join(repo, "src", "a.md"), "a3\n");
  writeFileSync(join(repo, "src", "b.md"), "b2\n");
  commit("c3", "2026-06-03T00:00:00Z");
  return repo;
}

test("git: derives deterministic temporal layers from a purpose-built repo", (t) => {
  if (!gitAvailable()) { t.skip("git is not installed in this environment"); return; }
  const repo = makeRepo(t);
  const g = deriveGit({ cwd: repo, pathspec: "src", now: "2026-06-09" });
  // deriveGit returning null here would mean repo detection or git invocation regressed —
  // fail loudly, never skip: git is present and the repo has history.
  assert.notEqual(g, null, "deriveGit must find the purpose-built repo's history");

  assert.equal(g.commitCount, 3);
  assert.equal(g.fileCount, 2);
  // churn: a.md changed in all 3 commits, b.md in 2 (c1, c3)
  assert.deepEqual(g.hotspots, [
    { file: "src/a.md", commits: 3 },
    { file: "src/b.md", commits: 2 },
  ]);
  // a.md and b.md co-change in c1 and c3 (0.5 each) → strength 1.0
  assert.deepEqual(g.coupling, [{ a: "src/a.md", b: "src/b.md", score: 1 }]);
  // dormancy is real and finite for both files
  assert.equal(g.dormant.length, 2);
  assert.ok(g.dormant.every((d) => Number.isFinite(d.days) && d.days >= 0));
  // all three commits overlap on files → one thread of size 3, oldest-first
  assert.equal(g.threads.length, 1);
  assert.equal(g.threads[0].size, 3);
  assert.deepEqual(g.threads[0].commits.map((c) => c.subject), ["c1", "c2", "c3"]);
  // oneline log is newest-first with well-formed sha/date
  assert.deepEqual(g.log.map((c) => c.subject), ["c3", "c2", "c1"]);
  assert.ok(g.log.every((c) => /^[0-9a-f]{7}$/.test(c.sha) && /^\d{4}-\d{2}-\d{2}$/.test(c.date)));

  const md = renderTemporalHtml(g);
  assert.match(md, /Evolution/);
  assert.match(md, /Commit log/);
  assert.match(md, /Hotspots/);
});

test("git: returns null for a nonexistent path (missing path, not a repo)", () => {
  assert.equal(deriveGit({ cwd: "/nonexistent-xyz-does-not-exist", pathspec: "src" }), null);
});

test("git: returns null for an existing directory that is not a git repo", (t) => {
  // distinct from the missing-path case: the directory EXISTS but has no history for the pathspec.
  const dir = mkdtempSync(join(tmpdir(), "wb-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(deriveGit({ cwd: dir, pathspec: "src" }), null);
});
