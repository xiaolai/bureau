// WI-6 - mechanical trust ledgers: fingerprints, path-jail, compile idempotence (roadmap §4.16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordVerification, recheckVerification, jailPath, markCompiled, readCompiled, uncompiled } from "../src/engine/ledgers.mjs";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "wb-ledg-"));
  const ws = join(root, "canon"); mkdirSync(ws, { recursive: true });
  return { root, ws, write: (rel, body) => { const p = join(root, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("verify: records a fingerprint; recheck ok until the artifact changes, then drifts", () => {
  const r = repo();
  try {
    r.write("package.json", '{"name":"x"}');
    const h = recordVerification(r.ws, { root: r.root, page: "Build cmd", artifact: "package.json", claim: "name is x", date: "2026-07-17" });
    assert.equal(h.length, 64);
    assert.deepEqual(recheckVerification(r.ws, { root: r.root, page: "Build cmd" }).map((c) => c.ok), [true]);
    r.write("package.json", '{"name":"CHANGED"}');
    const after = recheckVerification(r.ws, { root: r.root, page: "Build cmd" });
    assert.equal(after[0].ok, false); // this is what flips `verified` -> `stale`
  } finally { r.cleanup(); }
});

test("verify: re-recording the same artifact replaces, not duplicates", () => {
  const r = repo();
  try {
    r.write("a.txt", "one");
    recordVerification(r.ws, { root: r.root, page: "P", artifact: "a.txt", claim: "c", date: "2026-07-17" });
    r.write("a.txt", "two");
    recordVerification(r.ws, { root: r.root, page: "P", artifact: "a.txt", claim: "c2", date: "2026-07-17" });
    const checks = recheckVerification(r.ws, { root: r.root, page: "P" });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, true); // the second fingerprint is current
  } finally { r.cleanup(); }
});

test("jail: rejects absolute paths, `..` escapes, missing files, and symlinks out of the repo", () => {
  const r = repo();
  try {
    r.write("in.txt", "x");
    assert.throws(() => jailPath(r.root, "/etc/passwd"), /repo-relative/);
    assert.throws(() => jailPath(r.root, "../outside.txt"), /`\.\.`/);
    assert.throws(() => jailPath(r.root, "nope.txt"), /not found/);
    const outside = mkdtempSync(join(tmpdir(), "wb-out-"));
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(r.root, "link.txt"));
    assert.throws(() => jailPath(r.root, "link.txt"), /escapes the repo/);
    rmSync(outside, { recursive: true, force: true });
  } finally { r.cleanup(); }
});

test("compile-state: markCompiled is idempotent; uncompiled filters the watermark", () => {
  const r = repo();
  try {
    assert.equal(markCompiled(r.ws, ["s1", "s2"]), 2);
    assert.equal(markCompiled(r.ws, ["s2", "s3"]), 1); // s2 already present
    assert.deepEqual([...readCompiled(r.ws)].sort(), ["s1", "s2", "s3"]);
    assert.deepEqual(uncompiled(r.ws, ["s1", "s3", "s4"]), ["s4"]);
  } finally { r.cleanup(); }
});
