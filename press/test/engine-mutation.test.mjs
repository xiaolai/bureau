// WI-8 - gate-wiring mutation harness self-test (roadmap §4.13a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationGate, MUTATION_NOTE } from "../src/engine/mutation.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("mutation: a correctly wired tracked edge is killed (100% on a clean fixture)", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\", because: \"b\" }\n---\n# Down\nclaim ^d\n",
  });
  try {
    const r = mutationGate({ docsDir: w.dir });
    assert.equal(r.gateable, 1);
    assert.equal(r.killed, 1);
    assert.equal(r.killRate, 1);
    assert.equal(r.note, MUTATION_NOTE);
  } finally { w.cleanup(); }
});

test("mutation: a mis-wired edge (points at a ghost span) SURVIVES and is reported", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
    "d1.md": "---\nid: D1\ntitle: Down1\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\" }\n---\n# Down1\nc ^d1\n",
    "d2.md": "---\nid: D2\ntitle: Down2\nrests_on:\n  - { page: \"[[Up]]\", span: \"^ghost\" }\n---\n# Down2\nc ^d2\n",
  });
  try {
    const r = mutationGate({ docsDir: w.dir });
    assert.equal(r.killed, 1);                 // the real edge is killed
    assert.equal(r.killRate, 1);               // over GATEABLE edges (the ghost one isn't gateable)
    assert.ok(r.survivors.some((s) => s.dep === "D2" && s.reason === "target-span-missing"));
  } finally { w.cleanup(); }
});

test("mutation: an untracked edge is reported as not-gated (a wiring gap, not a kill)", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Down\nrests_on: \"[[Up]]\"\n---\n# Down\nc ^d\n",
  });
  try {
    const r = mutationGate({ docsDir: w.dir });
    assert.equal(r.untracked, 1);
    assert.ok(r.survivors.some((s) => s.reason === "untracked-not-gated"));
  } finally { w.cleanup(); }
});
