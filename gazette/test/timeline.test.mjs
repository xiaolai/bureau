import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { deriveTimeline } from "../src/derive/timeline.mjs";

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "gazette", "_data");

test("timeline: derives generated docs from data/cold-events.md", () => {
  const t = deriveTimeline(DATA);
  assert.equal(t.count, 4); // examples/data/cold-events.md has 4 events
  assert.ok(Object.keys(t.docs).length > 0);
  assert.ok(Object.keys(t.docs).some((k) => k.includes("Daily table")));
});

test("timeline: empty when no data dir", () => {
  const t = deriveTimeline("/nonexistent/data");
  assert.equal(t.count, 0);
  assert.deepEqual(Object.keys(t.docs), []); // docs is a null-proto object (prototype-pollution-safe)
});
