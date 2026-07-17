// WI-7 - fsck: rebuild the mechanical-derived tier to a byte-fixpoint; verify integrity + findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { fsck, GATE_BASENAME } from "../src/engine/fsck.mjs";
import { logPath } from "../src/engine/log.mjs";

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
    const cacheA = readFileSync(join(w.dir, GATE_BASENAME), "utf8");
    const b = fsck({ docsDir: w.dir });
    assert.equal(a.digest, b.digest);
    assert.equal(a.fixpointStable, true);
    assert.equal(readFileSync(join(w.dir, GATE_BASENAME), "utf8"), cacheA);
  } finally { w.cleanup(); }
});

test("fsck: dropping the mechanical cache and rebuilding reproduces identical bytes (regenerability)", () => {
  const w = ws({ "u.md": UP, "d.md": DOWN });
  try {
    scan({ docsDir: w.dir });
    const first = fsck({ docsDir: w.dir });
    const bytes = readFileSync(join(w.dir, GATE_BASENAME), "utf8");
    rmSync(join(w.dir, GATE_BASENAME));                       // drop the derived cache
    const rebuilt = fsck({ docsDir: w.dir });
    assert.equal(rebuilt.digest, first.digest);
    assert.equal(readFileSync(join(w.dir, GATE_BASENAME), "utf8"), bytes); // byte-identical
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
