// Dogfood fixture — bureau maintains its OWN knowledge base at canon/. This builds that real
// workspace with the shipped bundle and asserts it renders healthy. So a future change that
// breaks the canon (a dangling provenance link, an orphan page, an unresolved contradiction)
// fails CI: bureau tests itself on real data, not just synthetic examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAZETTE = join(ROOT, "press", "bin", "gazette.mjs");
const CANON = join(ROOT, "canon");
const T = 120000; // per-subprocess timeout so a hung build fails the test, not CI.

test("bureau's own canon builds healthy (self-dogfood)", (t) => {
  // A missing canon/ is a BROKEN gate, not a pass — only an explicit opt-out may skip it.
  if (!existsSync(CANON)) {
    if (process.env.BUREAU_ALLOW_NO_CANON) return t.skip("no canon/ workspace (opt-out set)");
    assert.fail("canon/ workspace is missing — the self-dogfood fixture was deleted (set BUREAU_ALLOW_NO_CANON=1 to skip intentionally)");
  }
  const out = mkdtempSync(join(tmpdir(), "canon-board-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  execFileSync("node", [GAZETTE, "build", "--dir", CANON, "--out", out], { cwd: ROOT, stdio: "ignore", timeout: T });
  const h = execFileSync("node", [GAZETTE, "health", "--dir", CANON], { cwd: ROOT, encoding: "utf8", timeout: T });
  const n = (re) => Number((h.match(re) || [])[1] ?? -1);
  assert.equal(n(/dangling links\s*:\s*(\d+)/), 0, "no dangling links (every provenance/wiki link resolves)");
  assert.equal(n(/orphans\s*:\s*(\d+)/), 0, "no orphan pages");
  assert.equal(n(/contradictions\s*:\s*(\d+)/), 0, "no unresolved contradictions");
  assert.ok(existsSync(join(out, "index.html")), "the board rendered");
});
