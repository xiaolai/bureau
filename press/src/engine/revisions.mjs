// engine/revisions - project per-span revisions from the decision log, and compute the composite
// verdict key (ADR-0001, Schema 1 + 2). A span_revision is the COUNT of introduce|edit events for a
// (uid, span) - a monotonic identity, NOT a content hash: a revert A->B->A yields r1->r2->r3 even
// though hash(A)==hash(A). Pure functions of the log (+ authored content for the hashes).
import { createHash } from "crypto";
import { canonicalJSON } from "../services/determinism.mjs";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
// A composite Map key that is collision-free regardless of what a uid or anchor contains. Used only
// for Map identity - span state values also carry uid/span explicitly, so nothing ever splits it.
export const spanKey = (uid, span) => canonicalJSON([String(uid), String(span)], 0);

export const spanHash = (text) => sha256(String(text == null ? "" : text));
export const becauseDigest = (s) => sha256(String(s == null ? "" : s));

// stable edge identity across because/revision churn -> the log can track one edge over time.
export function edgeId({ depUid, depSpan, targetUid, targetSpan }) {
  return sha256(canonicalJSON([depUid, depSpan || null, targetUid, targetSpan || null], 0));
}

// any component changing => new key => the edge re-opens review (ADR-0001, Schema 2).
export function verdictKey({ targetUid, targetSpan, targetRev, depUid, depSpan, depRev, becauseDig, schemaVersion }) {
  return sha256(canonicalJSON([targetUid, targetSpan || null, targetRev, depUid, depSpan || null, depRev, becauseDig || "", schemaVersion], 0));
}

// Fold the log into current span state: Map spanKey -> { uid, span, revision, hash, alive }. Dead
// spans are KEPT (alive:false) so a scan can tell "seen before, revived" (-> edit, revision++) from
// "brand new" (-> introduce, revision 1) - preserving monotonicity across a delete/re-add.
export function projectRevisions(events) {
  const spans = new Map();
  for (const ev of events) {
    if (ev.type === "introduce") spans.set(spanKey(ev.id, ev.span), { uid: ev.id, span: ev.span, revision: 1, hash: ev.hash, alive: true });
    else if (ev.type === "edit") {
      const s = spans.get(spanKey(ev.id, ev.span)) || { uid: ev.id, span: ev.span, revision: 0, hash: null, alive: true };
      spans.set(spanKey(ev.id, ev.span), { uid: ev.id, span: ev.span, revision: s.revision + 1, hash: ev.hash, alive: true });
    } else if (ev.type === "delete") { const s = spans.get(spanKey(ev.id, ev.span)); if (s) s.alive = false; }
    else if (ev.type === "split") {
      const s = spans.get(spanKey(ev.id, ev.from)); if (s) s.alive = false;
      for (const a of ev.into || []) if (!spans.has(spanKey(ev.id, a))) spans.set(spanKey(ev.id, a), { uid: ev.id, span: a, revision: 1, hash: null, alive: true });
    }
    // rename: uid is stable, so span identity is unaffected - no-op here.
  }
  return spans;
}

export function spanState(spans, uid, span) { return spans.get(spanKey(uid, span)) || null; }
export function spanRevision(spans, uid, span) { const s = spans.get(spanKey(uid, span)); return s && s.alive ? s.revision : 0; }
