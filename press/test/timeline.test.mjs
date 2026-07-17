import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { deriveTimeline } from "../src/derive/timeline.mjs";

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "gazette", "_data");

// a cold-events file that WOULD yield one event if read — used to prove a symlink is ignored
const REAL_COLD = "### D1\n\n- Court | something happened | fact | |\n";

test("timeline: derives generated docs from data/cold-events.md", () => {
  const res = deriveTimeline(DATA);
  assert.equal(res.count, 4); // examples/data/cold-events.md has 4 events
  assert.ok(Object.keys(res.docs).length > 0);
  assert.ok(Object.keys(res.docs).some((k) => k.includes("Daily table")));
});

test("timeline: empty for an absent data dir, and docs is a null-proto object", (t) => {
  // a freshly created temp root guarantees the child path is absent (no reliance on /nonexistent
  // which could, in principle, exist or resolve oddly in some environment)
  const root = mkdtempSync(join(tmpdir(), "wb-timeline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const res = deriveTimeline(join(root, "definitely-absent"));
  assert.equal(res.count, 0);
  assert.deepEqual(Object.keys(res.docs), []);
  // the null-proto claim must be asserted directly: an empty {} would also have zero keys, so
  // only getPrototypeOf actually proves the prototype-pollution-safe contract.
  assert.equal(Object.getPrototypeOf(res.docs), null, "docs must be a null-prototype object");
});

test("timeline: a symlinked cold-events.md is ignored — no read outside the tree", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-timeline-sym-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "_data");
  mkdirSync(data, { recursive: true });
  // a genuine cold-events file OUTSIDE the data dir that a followed symlink would smuggle in
  const outside = join(root, "outside-cold-events.md");
  writeFileSync(outside, REAL_COLD);
  try { symlinkSync(outside, join(data, "cold-events.md")); }
  catch (e) { t.skip("symlinks unsupported on this filesystem: " + e.message); return; }
  const res = deriveTimeline(data);
  // if the symlink were followed, REAL_COLD would produce 1 event — it must not be read.
  assert.equal(res.count, 0, "a symlinked cold-events.md must not be read");
  assert.deepEqual(Object.keys(res.docs), []);
});
