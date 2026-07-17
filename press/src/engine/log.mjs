// engine/log — the append-only decision log (ADR-0001, Schema 1). This is the SOURCE OF TRUTH:
// every mechanical-derived state (span revisions, verdict keys, dirty marks, backlinks) is a pure
// function of (authored snapshot + this log). Append is the only concurrent-safe primitive; the log
// is the serialization point. Each line is a JSON event carrying a monotonic `seq` and an integrity
// hash `ic` chaining it to every prior line, so a rewritten past line is detectable (tamper-evident).
//
// Node-only (the engine never runs in the browser): uses node:crypto sha256 freely.
import { existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { canonicalJSON } from "../services/determinism.mjs";

export const LOG_BASENAME = "_log.jsonl"; // underscore-prefixed → the renderer never picks it up
export function logPath(workspaceDir) { return join(workspaceDir, LOG_BASENAME); }

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

// the integrity link for event N: sha256(ic_{N-1} + canonicalJSON(event_without_ic)). ic_0 = "".
// `seq`/`ts` participate in the canonical form; `ic` itself does not (it wraps the rest).
function linkIc(prevIc, event) {
  const { ic, ...rest } = event; // eslint-disable-line no-unused-vars
  return sha256(String(prevIc || "") + canonicalJSON(rest, 0));
}

// Parse the raw file into events (no verification). Blank lines ignored. Throws on a non-JSON line
// (a corrupt log must fail loud, never be silently truncated).
function parseRaw(raw) {
  const events = [];
  const lines = String(raw).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (e) { throw new Error("decision log: line " + (i + 1) + " is not valid JSON: " + e.message); }
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) throw new Error("decision log: line " + (i + 1) + " is not a JSON object");
    events.push(ev);
  }
  return events;
}

// Verify seq monotonicity (1..n, no gaps/reorder) and the integrity chain. Returns
// { ok, badSeq, reason }. The FIRST divergence is reported (a rewritten past line breaks its own
// link and every link after it). Pure — used by readLog(strict) and by fsck.
export function verifyIntegrity(events) {
  let prevIc = "";
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const expectSeq = i + 1;
    if (ev.seq !== expectSeq) return { ok: false, badSeq: ev.seq ?? expectSeq, reason: "seq expected " + expectSeq + " got " + JSON.stringify(ev.seq) };
    if (typeof ev.ic !== "string") return { ok: false, badSeq: expectSeq, reason: "missing integrity hash" };
    if (linkIc(prevIc, ev) !== ev.ic) return { ok: false, badSeq: expectSeq, reason: "integrity hash mismatch (line altered)" };
    prevIc = ev.ic;
  }
  return { ok: true };
}

// Read + (by default) verify the log. `verify:false` returns raw events for tooling that repairs.
export function readLog(logFile, { verify = true } = {}) {
  if (!existsSync(logFile)) return [];
  const events = parseRaw(readFileSync(logFile, "utf8"));
  if (verify) {
    const v = verifyIntegrity(events);
    if (!v.ok) throw new Error("decision log integrity check failed at seq " + v.badSeq + ": " + v.reason + " (" + logFile + ")");
  }
  return events;
}

// { seq, ic } of the last event, or { seq: 0, ic: "" } for an absent/empty log.
export function head(logFile) {
  const events = readLog(logFile, { verify: false });
  if (!events.length) return { seq: 0, ic: "" };
  const last = events[events.length - 1];
  return { seq: last.seq, ic: last.ic };
}

// Validate the caller-supplied event shape: a plain object with a known `type`, no reserved
// machine fields (seq/ic are assigned here, never by the caller — a caller-set seq is a bug/attack).
const EVENT_TYPES = new Set(["introduce", "edit", "rename", "split", "delete", "confirm-edge", "approve", "reject", "resolve"]);
function validateEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error("log event must be an object");
  if (!EVENT_TYPES.has(event.type)) throw new Error('log event has unknown type: ' + JSON.stringify(event.type));
  if ("seq" in event || "ic" in event) throw new Error("log event must not set `seq`/`ic` (assigned by the log)");
}

// Append one event: assign the next seq + integrity link, write ONE full line (O_APPEND, so a
// concurrent append can never interleave a partial line). Returns the stored event. NOTE: seq is
// read-then-write — under true multi-writer concurrency use compareAndAppend for the CAS guard.
export function appendEvent(logFile, event) {
  validateEvent(event);
  const h = head(logFile);
  const stored = { seq: h.seq + 1, ...event };
  stored.ic = linkIc(h.ic, stored);
  appendFileSync(logFile, canonicalJSON(stored, 0) + "\n");
  return stored;
}

// Optimistic compare-and-swap: append ONLY if the on-disk head seq still equals `expectedSeq`.
// A hook that read stale state (expectedSeq behind the real head) is rejected, never clobbering.
export function compareAndAppend(logFile, expectedSeq, event) {
  const h = head(logFile);
  if (h.seq !== expectedSeq) {
    const err = new Error("decision log CAS failed: expected head seq " + expectedSeq + ", found " + h.seq);
    err.code = "ECASFAIL";
    throw err;
  }
  return appendEvent(logFile, event);
}
