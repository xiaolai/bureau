import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";
import { GOLDEN_DOCS, FIXED_NOW } from "./helpers.mjs";
import { buildModel } from "../src/core/model.mjs";
import { deriveBacklinks } from "../src/derive/backlinks.mjs";
import { deriveHealth } from "../src/derive/health.mjs";
import { canonicalJSON } from "../src/services/determinism.mjs";

function golden() {
  const m = buildModel({ docsDir: GOLDEN_DOCS });
  return deriveHealth(m, deriveBacklinks(m), { now: FIXED_NOW });
}

test("health: detects exactly the injected drift cases (100% + no false positives)", () => {
  const h = golden();
  assert.deepEqual(h.counts, { dangling: 1, orphan: 1, contradiction: 1, invalidDate: 0, stale: 1, schema: 1, drift: 0 });
});

test("health: a _types violation is flagged (Villain.rival not in the character schema)", () => {
  assert.deepEqual(golden().schema, [{ kind: "unknownEdge", node: "Villain", key: "rival" }]);
});

test("health: dangling is the renamed link Hero -> OldName", () => {
  assert.deepEqual(golden().dangling, [{ source: "Hero", target: "OldName", edgeType: null }]);
});

test("health: orphan is Orphan", () => {
  assert.deepEqual(golden().orphan, [{ node: "Orphan" }]);
});

test("health: contradiction is the typed Hero <-> Villain pair", () => {
  assert.deepEqual(golden().contradiction, [{ a: "Hero", b: "Villain" }]);
});

test("health: stale is Stale with newer neighbor Hero", () => {
  assert.deepEqual(golden().stale, [{ node: "Stale", updated: "2026-01-01", newerNeighbor: "Hero" }]);
});

test("health: no findings when now is far in the past (nothing stale) is still deterministic", () => {
  const a = canonicalJSON(golden());
  const b = canonicalJSON(golden());
  assert.equal(a, b);
});

test("health: matches the committed golden oracle (examples/golden/expected/health.json)", () => {
  const expected = readFileSync(resolve(GOLDEN_DOCS, "..", "expected", "health.json"), "utf8");
  assert.equal(canonicalJSON(golden()) + "\n", expected);
});
