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
  const approvedHash = new Map(); // uid → reviewed page digest of the effective approve (null = legacy/hashless)
  const approvedSeq = new Map();  // uid → seq of the effective approve (a scoped reject targets this)
  const resolved = new Map();     // conflictKey → resolution_id (EFFECTIVE resolutions only)
  const resolvedBy = new Map();   // conflictKey → { by, winner }
  const unauthorizedApprovals = new Map();   // uid → authority class of a REJECTED approve
  const unauthorizedResolutions = new Map(); // conflictKey → authority class of a REJECTED resolve
  const unauthorizedRejections = new Map();  // uid → authority class of an INERT (unauthorized) reject
  const staleRejections = [];                // rejects that matched no active/targeted approval (inert)
  // A batch's members take effect ONLY inside a WELL-FORMED bracket (ADR-0005 Decision B): exactly one
  // `batch-begin(id, n=k)`, exactly k decision members all sitting strictly between it and exactly one
  // `batch-commit(id)`. Anything malformed — a commit with no begin, a premature commit, a member
  // before/after the bracket, a count mismatch, a duplicate begin/commit — makes the whole batch inert,
  // so a crash mid-append or a hand-corrupted log projects to nothing. Events with no `batch_id` (every
  // event predating batches) are unaffected, so existing logs project identically.
  // A valid batch is a CONTIGUOUS run in the log: `batch-begin(id, n=k)` immediately followed by exactly
  // k decision members — each an `approve`/`reject` carrying `id`, and an `approve` needs a non-empty
  // `hash` — immediately followed by `batch-commit(id)`. appendBatch holds the lock for the whole batch,
  // so a real batch is always contiguous; anything interleaved / crossed / out-of-type / count-off /
  // hashless / duplicate-id is malformed and makes the batch inert.
  // Collect the exact INDICES of decision members inside a valid bracket — not just the batch id — so a
  // stray event that merely reuses a valid id (an out-of-bracket member, a duplicate begin/commit, a
  // `resolve` carrying the id) is still inert: only these precise member events project.
  const validMemberIdx = new Set();
  {
    // total count of events carrying each id — a valid bracket must account for EVERY one of them, so a
    // duplicate commit, a stray member, or a second begin (extra tagged events) tombstones the batch.
    const tagCount = new Map();
    for (const ev of events) if (ev.batch_id != null) tagCount.set(ev.batch_id, (tagCount.get(ev.batch_id) || 0) + 1);
    const seenId = new Set();
    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      if (ev.type !== "batch-begin") { i++; continue; }
      const id = ev.batch_id, n = ev.n;
      let ok = !seenId.has(id) && Number.isInteger(n) && n >= 0;
      seenId.add(id);
      let j = i + 1; const members = [];
      for (let c = 0; ok && c < n; c++, j++) {
        const m = events[j];
        if (!m || m.batch_id !== id || (m.type !== "approve" && m.type !== "reject")) { ok = false; break; }
        if (m.type === "approve" && !(typeof m.hash === "string" && m.hash.length > 0)) { ok = false; break; }
        members.push(j);
      }
      // exactly begin(1) + n members + commit(1) tagged events for this id — no more, no less
      if (ok && events[j] && events[j].type === "batch-commit" && events[j].batch_id === id && tagCount.get(id) === n + 2) { for (const mi of members) validMemberIdx.add(mi); i = j + 1; continue; }
      i++; // malformed begin — its members are not recorded, so they stay inert
    }
  }
  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx];
    if (ev.batch_id != null && !validMemberIdx.has(idx)) continue; // a batch-carrying event not an accepted member
    if (ev.type === "approve") {
      const by = authorityClass(ev.by);
      if (policy && !isAuthorized(policy, "approve", by)) { unauthorizedApprovals.set(ev.id, by); continue; } // recorded, NOT effective
      unauthorizedApprovals.delete(ev.id); unauthorizedRejections.delete(ev.id);
      approved.set(ev.id, ev.to_trust || "canonical"); approvedBy.set(ev.id, by);
      approvedHash.set(ev.id, ev.hash != null ? ev.hash : null); approvedSeq.set(ev.id, ev.seq != null ? ev.seq : null);
    } else if (ev.type === "reject") {
      // Revocation reuses the APPROVE authority (ADR-0004) — no separate policy key. An unauthorized
      // reject is INERT: it must not revoke a decision it lacks the authority to grant. This closes the
      // hole where any writer could un-approve a human decision by appending a bare reject.
      const by = authorityClass(ev.by);
      if (policy && !isAuthorized(policy, "approve", by)) { unauthorizedRejections.set(ev.id, by); continue; }
      // An AUTHORIZED reject supersedes any prior inert attempt AND any recorded unauthorized approve
      // for this uid, whatever the scoping outcome (matches the historical unconditional clearing, so a
      // stale finding can't linger after the human has acted).
      unauthorizedApprovals.delete(ev.id); unauthorizedRejections.delete(ev.id);
      // Scope: a reject may name the approval it revokes by `approval_seq` and/or `approval_hash`; it is
      // effective only against the CURRENT active approval matching EVERY field it provides — a stale /
      // duplicate / mismatched scoped reject is inert. A wholly UNSCOPED reject un-approves whatever is
      // active (exactly the historical behaviour), so no existing (unscoped) log changes meaning.
      const scoped = ev.approval_seq != null || ev.approval_hash != null;
      const matchesActive = approved.has(ev.id)
        && (ev.approval_seq == null || ev.approval_seq === approvedSeq.get(ev.id))
        && (ev.approval_hash == null || ev.approval_hash === approvedHash.get(ev.id));
      if (scoped && !matchesActive) {
        staleRejections.push({ id: ev.id, seq: ev.seq ?? null, why: approved.has(ev.id) ? "targets-superseded-approval" : "no-active-approval" });
        continue;
      }
      approved.delete(ev.id); approvedBy.delete(ev.id); approvedHash.delete(ev.id); approvedSeq.delete(ev.id);
    } else if (ev.type === "resolve") {
      const by = authorityClass(ev.by);
      if (policy && !isAuthorized(policy, "resolve", by)) { unauthorizedResolutions.set(ev.conflict, by); continue; }
      unauthorizedResolutions.delete(ev.conflict);
      resolved.set(ev.conflict, ev.resolution_id != null ? ev.resolution_id : ev.seq);
      resolvedBy.set(ev.conflict, { by, winner: ev.winner ?? null });
    }
  }
  return { approved, resolved, approvedBy, resolvedBy, approvedHash, approvedSeq, unauthorizedApprovals, unauthorizedResolutions, unauthorizedRejections, staleRejections };
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
