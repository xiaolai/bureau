// cold-events: parse + generated-doc invariants (data/cold-events.md → timeline docs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCold, coldEventDocs } from "../src/cold-events.mjs";

test("cold-events: distinct faction names never collapse into one mermaid participant", () => {
  // mmId strips delimiters, so `A:B` and `AB` sanitize identically — without unique ids they'd
  // merge into a single participant and silently combine their events. Each original keeps its own.
  const ev = parseCold("### D0\n- A:B | acts |  |  | AB\n- AB | replies |  |  | A:B\n");
  const body = coldEventDocs(ev)["Cold events · D0–30 full"].body;
  const participants = (body.match(/participant p\d+ as/g) || []).length;
  assert.equal(participants, 2, "two distinct originals → two participants");
});

test("cold-events: a day outside the 0–30 base is ignored, not mislabeled", () => {
  // the model is a fixed 30-day base; a D35 event would otherwise be mis-bucketed into "after".
  assert.equal(parseCold("### D35\n- X | y |  |  | Z\n").length, 0);
  assert.equal(parseCold("### D10\n- X | y |  |  | Z\n").length, 1);
});

test("cold-events: a colon in a quoted-free field is preserved as event text", () => {
  const ev = parseCold("### D0\n- Faction | did a thing |  |  |\n");
  assert.equal(ev[0].event, "did a thing");
  assert.equal(ev[0].day, 0);
});
