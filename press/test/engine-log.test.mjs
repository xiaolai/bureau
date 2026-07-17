// WI-3 — append-only decision log: ordering, CAS, tamper-evidence (ADR-0001, Schema 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, compareAndAppend, readLog, head, verifyIntegrity, logPath } from "../src/engine/log.mjs";

const newLog = () => logPath(mkdtempSync(join(tmpdir(), "wb-log-")));

test("append assigns monotonic seq from 1; readLog returns them in order", () => {
  const lf = newLog();
  appendEvent(lf, { type: "introduce", id: "P", span: "^a", hash: "h1" });
  appendEvent(lf, { type: "edit", id: "P", span: "^a", hash: "h2", prev: "h1" });
  const events = readLog(lf);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[1].type, "edit");
  assert.equal(head(lf).seq, 2);
});

test("each line is single-line JSON (valid JSONL)", () => {
  const lf = newLog();
  appendEvent(lf, { type: "introduce", id: "P", span: "^a", hash: "h1" });
  appendEvent(lf, { type: "rename", id: "P", from: "Old", to: "New" });
  const lines = readFileSync(lf, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test("CAS: stale expectedSeq is rejected; correct one appends", () => {
  const lf = newLog();
  appendEvent(lf, { type: "introduce", id: "P", span: "^a", hash: "h1" }); // head = 1
  assert.throws(() => compareAndAppend(lf, 0, { type: "edit", id: "P", span: "^a", hash: "h2" }), /CAS failed/);
  const ok = compareAndAppend(lf, 1, { type: "edit", id: "P", span: "^a", hash: "h2" });
  assert.equal(ok.seq, 2);
});

test("append refuses a caller-set seq/ic and an unknown type", () => {
  const lf = newLog();
  assert.throws(() => appendEvent(lf, { type: "edit", seq: 99, id: "P" }), /must not set/);
  assert.throws(() => appendEvent(lf, { type: "bogus", id: "P" }), /unknown type/);
});

test("tamper: a rewritten past line breaks the integrity chain and is flagged", () => {
  const lf = newLog();
  appendEvent(lf, { type: "introduce", id: "P", span: "^a", hash: "h1" });
  appendEvent(lf, { type: "edit", id: "P", span: "^a", hash: "h2", prev: "h1" });
  appendEvent(lf, { type: "edit", id: "P", span: "^a", hash: "h3", prev: "h2" });
  // rewrite line 1's content, keeping its seq (the classic silent-tamper)
  const lines = readFileSync(lf, "utf8").split("\n").filter(Boolean);
  const forged = JSON.parse(lines[0]); forged.hash = "TAMPERED";
  lines[0] = JSON.stringify(forged);
  writeFileSync(lf, lines.join("\n") + "\n");
  const v = verifyIntegrity(readLog(lf, { verify: false }));
  assert.equal(v.ok, false);
  assert.equal(v.badSeq, 1);
  assert.throws(() => readLog(lf), /integrity check failed at seq 1/);
});

test("integrity chain holds across many appends", () => {
  const lf = newLog();
  for (let i = 0; i < 50; i++) appendEvent(lf, { type: "edit", id: "P", span: "^a", hash: "h" + i });
  const events = readLog(lf); // verify:true — would throw on any break
  assert.equal(events.length, 50);
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 50 }, (_, i) => i + 1));
});
