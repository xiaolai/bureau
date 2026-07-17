// engine/gate - the L1 deterministic gate (ADR-0001; roadmap §3-L1, §4.2). For each tracked
// rests_on edge it computes the current verdict key and compares it to the last confirm-edge in the
// log. Key changed (or never confirmed) -> the dependent is needs-review; unchanged -> silent
// cutoff. Detection is EAGER (this dirty set is what query/status must consult); the semantic
// re-check behind it is deferred to 0.9. Pure: a function of (model, log events).
//
// Honesty: an UNTRACKED rests_on edge (bare string, no span) cannot be gated, so its dependent is
// conservatively needs-review and is EXCLUDED from the sound-gate guarantee / cutoff ratio.
import { projectRevisions, spanRevision, verdictKey, becauseDigest, edgeId } from "./revisions.mjs";
import { SCHEMA_VERSION } from "../core/model.mjs";

const RANK = { current: 0, "needs-review": 1, stale: 2 }; // stale (broken dep) outranks needs-review

// latest verdict key confirmed per edgeId (a later confirm-edge supersedes an earlier one)
export function lastConfirmations(events) {
  const m = new Map();
  for (const ev of events) if (ev.type === "confirm-edge") m.set(ev.edge, ev.verdict_key);
  return m;
}

// the dependent's representative claim span id = its FIRST author-anchored span (document order),
// or null if it anchors none. This is a STABLE id for the edge/verdict key (so it never churns).
function depSpanOf(node) { return node && node.spans && node.spans[0] ? "^" + node.spans[0].anchor : null; }
// the dependent's claim revision = the SUM of ALL its span revisions. Editing ANY claim on the
// dependent bumps the sum -> changes the verdict key -> re-opens the edge, so the gate never misses
// a change to a non-first claim on a multi-claim page. For a one-claim page (the atomic-page norm)
// the sum equals the single span's revision, so single-span edges keep identical verdict keys.
function depClaimRev(spans, node) {
  return (node && node.spans ? node.spans : []).reduce((sum, s) => sum + spanRevision(spans, node.uid, "^" + s.anchor), 0);
}

export function computeGate({ model, events, schemaVersion = SCHEMA_VERSION }) {
  const spans = projectRevisions(events);
  const confirmed = lastConfirmations(events);
  const byTitle = model.nodes;
  const freshness = new Map(); // uid -> level
  const bump = (uid, level) => { const cur = freshness.get(uid) || "current"; if (RANK[level] > RANK[cur]) freshness.set(uid, level); };
  for (const n of Object.values(byTitle)) freshness.set(n.uid, "current");

  const edges = [];
  let tracked = 0, cutoff = 0, open = 0, untracked = 0, broken = 0;
  for (const e of model.edges) {
    if (e.edgeType !== "rests_on") continue;
    const depUid = e.sourceUid;
    const depNode = byTitle[e.source];
    const depSpan = depSpanOf(depNode);

    if (!e.tracked) { // no span to anchor a verdict on
      untracked++; bump(depUid, "needs-review");
      edges.push({ dep: depUid, target: e.target, tracked: false, open: true, reason: "untracked" });
      continue;
    }
    // A tracked edge whose DEPENDENT anchors no claim span can't be gated on the downstream side —
    // an edit to the downstream claim would never bump a (nonexistent) dep_span_revision, so a
    // confirmed verdict could mask a changed claim. Treat it like untracked: conservatively
    // needs-review, and OUT of the sound-gate accounting (never cut off).
    if (!depSpan) {
      untracked++; bump(depUid, "needs-review");
      edges.push({ dep: depUid, target: e.target, span: e.span, tracked: false, open: true, reason: "downstream-unanchored" });
      continue;
    }
    const depRev = depClaimRev(spans, depNode); // sum over ALL the dependent's claim spans (#7)
    tracked++;
    const targetNode = byTitle[e.target];
    if (!targetNode) { broken++; bump(depUid, "stale"); edges.push({ dep: depUid, target: e.target, span: e.span, tracked: true, open: true, broken: true, reason: "missing-target" }); continue; }
    const targetUid = targetNode.uid, targetSpan = e.span;
    const targetRev = spanRevision(spans, targetUid, targetSpan);
    const eid = edgeId({ depUid, depSpan, targetUid, targetSpan });
    if (targetRev === 0) { broken++; bump(depUid, "stale"); edges.push({ edgeId: eid, dep: depUid, target: e.target, span: targetSpan, tracked: true, open: true, broken: true, reason: "target-span-missing" }); continue; }
    const vk = verdictKey({ targetUid, targetSpan, targetRev, depUid, depSpan, depRev, becauseDig: becauseDigest(e.because), schemaVersion });
    const last = confirmed.get(eid) || null;
    const isOpen = last == null || last !== vk;
    if (isOpen) { open++; bump(depUid, "needs-review"); } else cutoff++;
    edges.push({ edgeId: eid, dep: depUid, target: e.target, span: targetSpan, targetRev, depRev, verdictKey: vk, confirmed: last, tracked: true, open: isOpen });
  }

  const dirty = [...freshness.entries()].filter(([, v]) => v !== "current").map(([uid, v]) => ({ uid, freshness: v })).sort((a, b) => (a.uid < b.uid ? -1 : 1));
  // cutoff ratio is over TRACKED edges only, and is meaningless in isolation (roadmap §4.14) -
  // callers must report it beside edgeCount. A ratio inflated by deleting edges is under-scoping.
  const cutoffRatio = tracked ? cutoff / tracked : null;
  return { freshness, edges, dirty, counts: { tracked, untracked, cutoff, open, broken }, cutoffRatio };
}

// Reverse rests_on transitive closure: who (transitively) could need review if `rootUid` changes.
// This is the SPECULATIVE worst-case blast radius (impact query), distinct from the precise one-hop
// freshness above - it assumes propagation at every hop. Cycle-safe: a visited (uid) token bounds
// it to at-most-once per node per run (span_revision is fixed within a run, so uid suffices).
export function blastRadius(model, rootUid) {
  const rev = new Map(); // targetUid -> [dependent uids]
  for (const e of model.edges) {
    if (e.edgeType !== "rests_on") continue;
    const t = model.nodes[e.target]; if (!t) continue;
    if (!rev.has(t.uid)) rev.set(t.uid, []);
    rev.get(t.uid).push(e.sourceUid);
  }
  // Seed visited with the root so a cycle back to root never re-adds or re-processes it — the
  // (node) visited token guarantees at-most-once, and the root is not a dependent of itself.
  const visited = new Set([rootUid]), order = [];
  let processed = 0;
  const stack = [rootUid];
  while (stack.length) {
    const u = stack.pop(); processed++;
    for (const dep of rev.get(u) || []) if (!visited.has(dep)) { visited.add(dep); order.push(dep); stack.push(dep); }
  }
  return { affected: order.sort(), processed };
}
