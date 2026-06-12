import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { deriveGit, renderTemporalHtml } from "../src/derive/git.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // the plugin repo (has git history)

test("git: derives temporal layers from the repo's own history of src/", () => {
  const g = deriveGit({ cwd: REPO, pathspec: "src", now: "2026-06-09" });
  if (g === null) return; // no git in this environment — skip gracefully
  assert.ok(g.commitCount > 0);
  assert.ok(Array.isArray(g.hotspots) && g.hotspots.every((h) => typeof h.file === "string" && h.commits >= 1));
  assert.ok(Array.isArray(g.dormant) && g.dormant.every((d) => Number.isFinite(d.days)));
  assert.ok(Array.isArray(g.coupling));
  // commit grouping + oneline log
  assert.ok(Array.isArray(g.threads) && g.threads.every((t) => t.size >= 2 && Array.isArray(t.commits)));
  assert.ok(Array.isArray(g.log) && g.log.every((c) => /^[0-9a-f]{7}$/.test(c.sha) && /^\d{4}-\d{2}-\d{2}$/.test(c.date) && typeof c.subject === "string"));
  const md = renderTemporalHtml(g);
  assert.match(md, /Evolution/);
  assert.match(md, /Commit log/);
});

test("git: returns null for a non-repo path (graceful)", () => {
  assert.equal(deriveGit({ cwd: "/nonexistent-xyz", pathspec: "docs" }), null);
});
