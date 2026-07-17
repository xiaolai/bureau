// engine/state — project the DECIDED fields (trust:canonical, conflict:resolved) from the decision
// log (ADR-0001, §2.3). `canonical` is a PROJECTION of an `approve` event, never authoritative from
// frontmatter alone: an authored `trust: canonical` with no approval is reported `trustBacked:false`
// so the gate can flag it rather than silently trusting it. `freshness` is NOT here — it is derived
// by the gate (engine/gate.mjs) because it depends on upstream span revisions.
export const CONFLICT_SEP = " × ";
export function conflictKey(uidA, uidB) { return [uidA, uidB].sort().join(CONFLICT_SEP); }

// Fold approve/reject/resolve events into lookup maps.
export function projectDecisions(events) {
  const approved = new Map(); // uid → trust granted by the last approve (default 'canonical')
  const resolved = new Map(); // conflictKey → resolution_id
  for (const ev of events) {
    if (ev.type === "approve") approved.set(ev.id, ev.to_trust || "canonical");
    else if (ev.type === "reject") approved.delete(ev.id);            // a rejection un-approves
    else if (ev.type === "resolve") resolved.set(ev.conflict, ev.resolution_id != null ? ev.resolution_id : ev.seq);
  }
  return { approved, resolved };
}

// Resolve one node's decided state. `conflictPartnerUids` are the uids this node `contradicts:`.
// trust:  an approve event wins (backed); else the authored trust (unbacked if it claims canonical).
// conflict: none if no contradicts; resolved if every conflict key is in the log; else contested.
export function resolveNodeState(node, decisions, conflictPartnerUids = []) {
  const approvedTrust = decisions.approved.get(node.uid);
  const authored = node.trust || null;
  const trust = approvedTrust || authored;
  const trustBacked = approvedTrust != null || (authored !== "canonical"); // authored-canonical needs an approval

  let conflict = "none", resolutionId = null;
  if (conflictPartnerUids.length) {
    const keys = conflictPartnerUids.map((p) => conflictKey(node.uid, p));
    const allResolved = keys.every((k) => decisions.resolved.has(k));
    conflict = allResolved ? "resolved" : "contested";
    if (allResolved) resolutionId = decisions.resolved.get(keys[0]) ?? null;
  }
  return { trust, trustBacked, conflict, resolutionId, freeze: node.freeze || null };
}
