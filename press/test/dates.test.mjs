import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate } from "../src/services/dates.mjs";

test("dates: valid YYYY-MM-DD parses to UTC midnight (not local time, not a shifted day)", () => {
  const d = parseDate("2026-06-09");
  assert.equal(d.valid, true);
  assert.equal(d.present, true);
  // pin the EXACT instant: UTC midnight of 2026-06-09 (month is 0-indexed → 5).
  // typeof-number would also pass for a local-time or off-by-one-day parse; this won't.
  assert.equal(d.ts, Date.UTC(2026, 5, 9));
  assert.equal(new Date(d.ts).toISOString(), "2026-06-09T00:00:00.000Z");
});

test("dates: calendar rollover is rejected, not silently shifted (H6)", () => {
  // Date.parse('2025-02-30') would yield Mar 2 — must be flagged invalid instead.
  const d = parseDate("2025-02-30");
  assert.equal(d.present, true);
  assert.equal(d.valid, false);
  assert.equal(d.ts, null);
});

test("dates: malformed strings are present-but-invalid", () => {
  for (const s of ["2026", "not-a-date", "06/09/2026", "2026-6-9", "yesterday"]) {
    const d = parseDate(s);
    assert.equal(d.present, true, s);
    assert.equal(d.valid, false, s);
  }
});

test("dates: absent is present:false", () => {
  for (const s of [null, undefined, ""]) {
    const d = parseDate(s);
    assert.equal(d.present, false);
    assert.equal(d.valid, false);
  }
});
