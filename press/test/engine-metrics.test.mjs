// WI-9 - deterministic, auditable metrics (roadmap §4.15, §9.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/engine/scan.mjs";
import { report, renderMetricsText } from "../src/engine/metrics.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-metrics-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const FIX = {
  "u.md": "---\nid: U\ntitle: Up\n---\n# Up\ndef ^u\n",
  "d.md": "---\nid: D\ntitle: Down\nrests_on:\n  - { page: \"[[Up]]\", span: \"^u\", because: \"b\" }\n---\n# Down\nclaim ^d\n",
};

test("metrics: report is deterministic (same corpus+log → identical numbers)", () => {
  const w = ws(FIX);
  try {
    scan({ docsDir: w.dir });
    const a = report({ docsDir: w.dir });
    const b = report({ docsDir: w.dir });
    assert.deepEqual(a, b);
  } finally { w.cleanup(); }
});

test("metrics: carries the three auditable numbers + the cutoff-ratio-beside-edge-count rule", () => {
  const w = ws(FIX);
  try {
    scan({ docsDir: w.dir });
    const r = report({ docsDir: w.dir });
    assert.equal(r.fixpoint.stable, true);
    assert.equal(typeof r.fixpoint.digest, "string");
    assert.equal(r.gate.trackedEdges, 1);          // cutoff ratio is meaningless without this
    assert.equal(r.wiring.killRate, 1);
    const txt = renderMetricsText(r);
    assert.match(txt, /cutoff ratio/);
    assert.match(txt, /kill rate/);
  } finally { w.cleanup(); }
});
