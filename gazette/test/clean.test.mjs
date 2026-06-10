import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { FIXED_NOW } from "./helpers.mjs";
import { buildModel } from "../src/core/model.mjs";
import { deriveBacklinks } from "../src/derive/backlinks.mjs";
import { deriveHealth, healthTotal } from "../src/derive/health.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLEAN_DOCS = resolve(here, "..", "examples", "clean", "gazette");

test("health: clean corpus reports ZERO findings (M8 — no false positives)", () => {
  const m = buildModel({ docsDir: CLEAN_DOCS });
  const h = deriveHealth(m, deriveBacklinks(m), { now: FIXED_NOW });
  assert.deepEqual(h.counts, { dangling: 0, orphan: 0, contradiction: 0, invalidDate: 0, stale: 0, schema: 0, drift: 0 });
  assert.equal(healthTotal(h), 0);
});

test("health: staleness is date-relative — now BEFORE all updates yields 0 stale", () => {
  const m = buildModel({ docsDir: CLEAN_DOCS });
  const h = deriveHealth(m, deriveBacklinks(m), { now: "2020-01-01" });
  assert.equal(h.counts.stale, 0);
});
