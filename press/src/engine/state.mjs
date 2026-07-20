// engine/state — project the DECIDED fields (trust:canonical, conflict:resolved) from the decision
// log (ADR-0001, §2.3). `canonical` is a PROJECTION of an `approve` event, never authoritative from
// frontmatter alone: an authored `trust: canonical` with no approval is reported `trustBacked:false`
// so the gate can flag it rather than silently trusting it. `freshness` is NOT here — it is derived
// by the gate (engine/gate.mjs) because it depends on upstream span revisions.
import { authorityClass, isAuthorized } from "./policy.mjs";

export const CONFLICT_SEP = " × ";

// LEGACY key: a bare separator join. It is COLLISION-PRONE — a uid may itself contain the separator,
// so `["A × B", "C"]` and `["A", "B × C"]` both render `A × B × C` and resolving either resolves the
// other. Kept only to read conflict keys already written into existing decision logs.
export function legacyConflictKey(uidA, uidB) { return [String(uidA), String(uidB)].sort().join(CONFLICT_SEP); }

// Current key: LENGTH-PREFIXED, so no uid's content can forge another pair's key. `c2:` versions the
// encoding, keeping it distinguishable from a legacy key at a glance and in the log.
export function conflictKey(uidA, uidB) {
  const [a, b] = [String(uidA), String(uidB)].sort();
  return "c2:" + a.length + ":" + a + ":" + b.length + ":" + b;
}

// Every key a stored resolution for this pair could be under — current first, then legacy. Lookups go
// through this so a log written before the encoding change keeps resolving.
export function conflictKeyCandidates(uidA, uidB) { return [conflictKey(uidA, uidB), legacyConflictKey(uidA, uidB)]; }

// Fold approve/reject/resolve events into lookup maps.
//
// AUTHORITY IS PART OF THE PROJECTION, not a separate check bolted on afterwards. An earlier cut
// recorded `approvedBy` but still projected every approval into `approved`, so a machine authority the
// policy rejects could still promote a page to `canonical` — callers keying off the AUTHORED tier then
// skipped it entirely and the gate was bypassed. Now: when a `policy` is supplied, an approval or a
// resolution whose authority the policy does not accept is recorded (so it can be REPORTED) but does
// NOT take effect. With no policy the legacy behaviour is preserved exactly.
export function projectDecisions(events, policy = null) {
  const approved = new Map();     // uid → trust granted by the last EFFECTIVE approve (default 'canonical')
  const approvedBy = new Map();   // uid → authority class of that approve
  const resolved = new Map();     // conflictKey → resolution_id (EFFECTIVE resolutions only)
  const resolvedBy = new Map();   // conflictKey → { by, winner }
  const unauthorizedApprovals = new Map();   // uid → authority class of a REJECTED approve
  const unauthorizedResolutions = new Map(); // conflictKey → authority class of a REJECTED resolve
  for (const ev of events) {
    if (ev.type === "approve") {
      const by = authorityClass(ev.by);
      if (policy && !isAuthorized(policy, "approve", by)) { unauthorizedApprovals.set(ev.id, by); continue; } // recorded, NOT effective
      unauthorizedApprovals.delete(ev.id);
      approved.set(ev.id, ev.to_trust || "canonical"); approvedBy.set(ev.id, by);
    } else if (ev.type === "reject") {
      approved.delete(ev.id); approvedBy.delete(ev.id); unauthorizedApprovals.delete(ev.id); // a rejection un-approves
    } else if (ev.type === "resolve") {
      const by = authorityClass(ev.by);
      if (policy && !isAuthorized(policy, "resolve", by)) { unauthorizedResolutions.set(ev.conflict, by); continue; }
      unauthorizedResolutions.delete(ev.conflict);
      resolved.set(ev.conflict, ev.resolution_id != null ? ev.resolution_id : ev.seq);
      resolvedBy.set(ev.conflict, { by, winner: ev.winner ?? null });
    }
  }
  return { approved, resolved, approvedBy, resolvedBy, unauthorizedApprovals, unauthorizedResolutions };
}

// Resolve one node's decided state. `conflictPartnerUids` are the uids this node `contradicts:`.
// trust:  an approve event wins (backed); else the authored trust (unbacked if it claims canonical).
// conflict: none if no contradicts; resolved if every conflict key is in the log; else contested.
// A resolution only counts for the conflict it names. `resolve` carries a `winner`, and the log
// validates only that it is a non-empty STRING — so a resolution naming an unrelated uid would
// otherwise mark the pair resolved. Require the winner to be one of the two endpoints; anything else
// is a malformed/orphan resolution and leaves the conflict CONTESTED (fail closed).
// Returns the MATCHED record (including which key encoding it was stored under) rather than a bare
// id — the caller needs the winner/authority from the SAME key that matched. Re-deriving that meta
// from the current encoding alone would come back empty for a resolution logged under a legacy key.
function resolutionFor(decisions, uidA, uidB) {
  for (const key of conflictKeyCandidates(uidA, uidB)) { // current encoding first, then legacy
    if (!decisions.resolved.has(key)) continue;
    const meta = (decisions.resolvedBy && decisions.resolvedBy.get(key)) || null;
    if (meta && meta.winner != null && meta.winner !== uidA && meta.winner !== uidB) return null; // orphan winner
    return { key, resolutionId: decisions.resolved.get(key) ?? null, winner: meta ? meta.winner : null, by: meta ? meta.by : null };
  }
  return null;
}

export function resolveNodeState(node, decisions, conflictPartnerUids = []) {
  // `approved` already excludes any approval the policy rejected (see projectDecisions), so an
  // unauthorized approval can neither promote the tier nor back it — the projection is the gate.
  const approvedTrust = decisions.approved.get(node.uid);
  const authored = node.trust || null;
  const trust = approvedTrust || authored;
  const trustBacked = approvedTrust != null || (authored !== "canonical"); // authored-canonical needs an approval

  let conflict = "none", resolutionId = null, resolutions = [];
  if (conflictPartnerUids.length) {
    // sorted by key so nothing here depends on edge-iteration order (the derived tier is a
    // byte-fixpoint; picking "the first partner" unsorted would make it order-sensitive).
    const entries = conflictPartnerUids
      .map((p) => ({ key: conflictKey(node.uid, p), partner: p }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    resolutions = entries.map((e) => {
      const r = resolutionFor(decisions, node.uid, e.partner);
      return { conflict: e.key, resolutionId: r ? r.resolutionId : null, winner: r ? r.winner : null, by: r ? r.by : null };
    });
    const allResolved = resolutions.every((r) => r.resolutionId != null);
    conflict = allResolved ? "resolved" : "contested";
    // `resolutionId` stays singular for the common one-conflict page; a page contradicting SEVERAL
    // pages has independent resolutions, and collapsing them to the first misrepresented them — the
    // full set now travels in `resolutions`.
    if (allResolved) resolutionId = resolutions.length === 1 ? resolutions[0].resolutionId : null;
  }
  return { trust, trustBacked, conflict, resolutionId, resolutions, freeze: node.freeze || null };
}
