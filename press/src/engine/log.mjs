// engine/log — the append-only decision log (ADR-0001, Schema 1). This is the SOURCE OF TRUTH:
// every mechanical-derived state (span revisions, verdict keys, dirty marks, backlinks) is a pure
// function of (authored snapshot + this log). Append is the only concurrent-safe primitive; the log
// is the serialization point. Each line is a JSON event carrying a monotonic `seq` and an integrity
// hash `ic` chaining it to every prior line, so a rewritten past line is detectable (tamper-evident).
//
// Node-only (the engine never runs in the browser): uses node:crypto sha256 freely.
import { existsSync, readFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from "fs";
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

// Validate the caller-supplied event shape: a plain object with a known `type`, the fields that type
// requires (well-formed strings / ^spans / arrays), and no reserved machine fields (seq/ic are
// assigned here, never by the caller — a caller-set seq is a bug/attack). The log is trust-critical;
// a malformed event must never enter it.
const EVENT_TYPES = new Set(["introduce", "edit", "rename", "split", "delete", "confirm-edge", "approve", "reject", "resolve"]);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isSpan = (v) => typeof v === "string" && /^\^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v);
// hash/verdict_key are OPAQUE fingerprints (the integrity chain, not their format, guards the log),
// so they are validated as non-empty strings, not a fixed shape. `to_trust` is a closed enum.
const TRUST_TIERS = new Set(["proposed", "verified", "canonical"]);
const REQUIRED = {
  introduce: (e) => isStr(e.id) && isSpan(e.span) && isStr(e.hash),
  edit: (e) => isStr(e.id) && isSpan(e.span) && isStr(e.hash),
  rename: (e) => isStr(e.id) && isStr(e.from) && isStr(e.to),
  split: (e) => isStr(e.id) && isSpan(e.from) && Array.isArray(e.into) && e.into.length > 0 && e.into.every(isSpan),
  delete: (e) => isStr(e.id) && isSpan(e.span),
  "confirm-edge": (e) => isStr(e.edge) && isStr(e.verdict_key),
  approve: (e) => isStr(e.id) && (e.to_trust == null || TRUST_TIERS.has(e.to_trust)),
  reject: (e) => isStr(e.id),
  resolve: (e) => isStr(e.conflict) && isStr(e.winner),
};
function validateEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error("log event must be an object");
  if (!EVENT_TYPES.has(event.type)) throw new Error("log event has unknown type: " + JSON.stringify(event.type));
  if ("seq" in event || "ic" in event) throw new Error("log event must not set `seq`/`ic` (assigned by the log)");
  if (!REQUIRED[event.type](event)) throw new Error("malformed " + event.type + " event (missing/invalid required fields): " + canonicalJSON(event, 0));
}

// Serialize read-head-then-append across processes with an advisory lock file. Node is
// single-threaded, so within ONE process the whole (head → link → append) sequence is already
// atomic; the lock closes the CROSS-process window (a hook and a CLI run touching the same log).
// A stale lock left by a crashed writer is stolen after STALE_MS. ts/lock timing is runtime-only
// and never part of the byte-fixpoint, so wall-clock here is fine.
const STALE_LOCK_MS = 30000;
export function withLock(logFile, fn) {
  const lock = logFile + ".lock";
  let fd = null;
  for (let i = 0; i < 200 && fd == null; i++) {
    try { fd = openSync(lock, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) { unlinkSync(lock); continue; } } catch { /* lock vanished — retry */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); // 15ms backoff, no busy-spin
    }
  }
  if (fd == null) throw new Error("could not acquire decision-log lock (held > " + (200 * 15) + "ms): " + lock);
  try { return fn(); } finally { try { closeSync(fd); } catch { /* already closed */ } try { unlinkSync(lock); } catch { /* already gone */ } }
}

function appendLocked(logFile, event) {
  const h = head(logFile);
  const stored = { seq: h.seq + 1, ...event };
  stored.ic = linkIc(h.ic, stored);
  appendFileSync(logFile, canonicalJSON(stored, 0) + "\n");
  return stored;
}

// Append one event: assign the next seq + integrity link and write ONE full line, under the lock so
// the head read and the append cannot interleave with another writer.
export function appendEvent(logFile, event) {
  validateEvent(event);
  return withLock(logFile, () => appendLocked(logFile, event));
}

// Optimistic compare-and-swap: the head check and the append happen under ONE lock, so a writer that
// read stale state (expectedSeq behind the real head) is rejected, never clobbering.
export function compareAndAppend(logFile, expectedSeq, event) {
  validateEvent(event);
  return withLock(logFile, () => {
    const h = head(logFile);
    if (h.seq !== expectedSeq) {
      const err = new Error("decision log CAS failed: expected head seq " + expectedSeq + ", found " + h.seq);
      err.code = "ECASFAIL";
      throw err;
    }
    return appendLocked(logFile, event);
  });
}

// Atomic batch append: acquire the lock ONCE, read the current log inside it, let `produce(current)`
// compute the events to append from that locked snapshot, then validate + append them all. This is
// how a multi-event producer (scan) stays consistent — the diff is computed against, and appended
// onto, the SAME locked state, so two concurrent scans can't double-append.
export function appendBatch(logFile, produce) {
  return withLock(logFile, () => {
    const current = readLog(logFile);
    const toAppend = produce(current) || [];
    const stored = [];
    for (const ev of toAppend) { validateEvent(ev); stored.push(appendLocked(logFile, ev)); }
    return stored;
  });
}
