// The shared review-state model (ADR-0005 Decision A). ONE projection that the CLI (`review --next`),
// the chamber queue, and the review skill all consume, so no surface re-derives — or disagrees about —
// what needs review.
//
// A backlog is NOT a flat "approve these" list. Three axes are orthogonal:
//   • trust     — engine/effective.mjs (proposed/verified · stale · unbacked · unauthorized)
//   • freshness — liveFreshness / the gate (a CANONICAL page can be dependency-dirty → confirm, not approve)
//   • conflict  — the decided projection (contested pages, possibly with MANY partners; "approve both"
//                 is not resolution)
// so we emit TYPED work items, each naming the action that clears it:
//   approve               authored proposed/verified (or unbacked/unauthorized canonical), not effective
//   reapprove             a content-bound approval gone stale (page edited past its review)
//   confirm-dependencies  effectively canonical BUT dependency-dirty (needs `confirm-edge`)
//   resolve-conflict      a contested COMPONENT (all `contradicts`-linked pages) — needs `resolve`
//   repair-edge           a `rests_on` edge whose target/span is missing
// Ordered topologically over `rests_on` (SCC-condensed for cycles), conflict components grouped.
// Computed over `liveFreshness`, so unscanned working-tree edits count.
import { loadCorpus, buildModel } from "../core/model.mjs";
import { effectiveReview } from "./effective.mjs";
import { liveFreshness } from "./live.mjs";
import { reviewDigest } from "./review-digest.mjs";

const APPROVE_INTENT = new Set(["proposed", "verified", "stale", "contested"]);
const WHY = {
  approve: "not yet approved — read and approve to make it canonical",
  reapprove: "approved, then edited — re-approve to rebind the reviewed bytes",
  "confirm-dependencies": "canonical but rests on a changed/broken upstream span — confirm the edge",
  "repair-edge": "rests_on a missing target/span — fix the link",
  "resolve-conflict": "contested — resolve which claim stands (do NOT approve both)",
};

// Tarjan SCC → an upstream-first order over `deps`. Iterative (explicit stack) so a self-cycle or a
// large cycle can neither blow the call stack nor hang; deterministic given a stable `uids` order.
function sccOrder(uids, deps) {
  const pos = new Map(uids.map((u, i) => [u, i]));
  const member = new Set(uids);
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const comps = []; // sink-first (Tarjan order)
  let idx = 0;
  for (const start of uids) {
    if (index.has(start)) continue;
    const work = [{ u: start, i: 0, succ: null }];
    while (work.length) {
      const frame = work[work.length - 1], u = frame.u;
      if (frame.succ === null) {
        index.set(u, idx); low.set(u, idx); idx++; stack.push(u); onStack.add(u);
        frame.succ = [...(deps.get(u) || [])].filter((v) => member.has(v)).sort((a, b) => pos.get(a) - pos.get(b));
      }
      if (frame.i < frame.succ.length) {
        const v = frame.succ[frame.i++];
        if (!index.has(v)) work.push({ u: v, i: 0, succ: null });
        else if (onStack.has(v)) low.set(u, Math.min(low.get(u), index.get(v)));
      } else {
        if (low.get(u) === index.get(u)) {
          const comp = [];
          for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === u) break; }
          comps.push(comp);
        }
        work.pop();
        if (work.length) { const p = work[work.length - 1].u; low.set(p, Math.min(low.get(p), low.get(u))); }
      }
    }
  }
  // Tarjan emits SCCs sink-first, i.e. a page's `rests_on` targets complete before it — which is exactly
  // upstream-first (review what everything rests on before the dependents). Iterate forward.
  const order = [];
  for (let i = 0; i < comps.length; i++) for (const m of comps[i].sort((a, b) => pos.get(a) - pos.get(b))) order.push(m);
  return order;
}

export function reviewQueue({ docsDir, corpus, model, events, policy } = {}) {
  corpus = corpus || loadCorpus({ docsDir });
  model = model || buildModel({ corpus });
  const nodes = Object.values(model.nodes);
  const byUid = new Map(nodes.map((n) => [n.uid, n]));
  const keyByUid = corpus.keyByUid, uidByKey = corpus.uidByKey;

  // trust + conflict from the projection (fsck, read-only)
  const { canonical, report } = effectiveReview({ docsDir, corpus, events, policy });
  const decided = new Map(report.derived.decided.map((d) => [d.uid, d]));
  const findingKinds = new Map();
  for (const f of report.findings) if (f.uid != null) {
    if (!findingKinds.has(f.uid)) findingKinds.set(f.uid, new Set());
    findingKinds.get(f.uid).add(f.kind);
  }
  // freshness over the working tree (unscanned edits count)
  const fresh = liveFreshness({ corpus, docsDir, model, policy });
  const freshOf = (uid) => (keyByUid ? fresh.byKey.get(keyByUid.get(uid)) : null) || "current";

  // rests_on (order + broken) and contradicts (conflict components) graphs, keyed by uid
  const restsOn = new Map(), contradicts = new Map(), brokenEdge = new Set();
  for (const e of model.edges) {
    const src = e.sourceUid, tgt = uidByKey ? uidByKey.get(e.target) : null;
    if (e.edgeType === "rests_on") {
      if (tgt == null) { brokenEdge.add(src); continue; } // missing target → broken
      if (!restsOn.has(src)) restsOn.set(src, new Set());
      restsOn.get(src).add(tgt);
    } else if (e.edgeType === "contradicts" && tgt != null) {
      if (!contradicts.has(src)) contradicts.set(src, new Set());
      if (!contradicts.has(tgt)) contradicts.set(tgt, new Set());
      contradicts.get(src).add(tgt); contradicts.get(tgt).add(src); // a contradiction is mutual
    }
  }
  // a BROKEN rests_on (missing target OR missing span) is a repair-edge, not a confirm — `gazette confirm`
  // can't clear a broken edge. The gate reports both cases via liveFreshness drift ("broken dependency").
  for (const d of fresh.drift || []) if (d.reason && /broken/i.test(d.reason)) { const u = uidByKey ? uidByKey.get(d.page) : null; if (u) brokenEdge.add(u); }

  const title = (uid) => (byUid.get(uid) ? byUid.get(uid).title : null);
  // the current content digest — carried on approvable items so `review --json` can seed a `--from`
  // manifest (each approval must pin the reviewed bytes; the digest travels review → manifest → apply).
  const rawByUid = new Map((corpus.entries || []).map((e) => [e.uid, e.raw]));
  const digestOf = (uid) => { const raw = rawByUid.get(uid), n = byUid.get(uid); try { return raw != null && n ? reviewDigest({ raw, uid, title: n.title }) : null; } catch { return null; } };

  // base kind (trust/freshness/edge) — conflict is resolved as components below, not per page
  const baseKind = (uid) => {
    const kinds = findingKinds.get(uid) || new Set();
    const n = byUid.get(uid), authored = n ? (n.trust || n.status || null) : null;
    const fr = freshOf(uid);
    if (brokenEdge.has(uid)) return "repair-edge";      // a broken dependency blocks any trust action first
    if (kinds.has("stale-approval")) return "reapprove";
    if (kinds.has("unbacked-canonical") || kinds.has("unauthorized-canonical")) return "approve";
    if (canonical.has(uid)) return (fr === "needs-review" || fr === "stale") ? "confirm-dependencies" : null;
    if (APPROVE_INTENT.has(authored)) return "approve";
    return null;
  };

  // contested components: connected sub-graphs of the (symmetric) contradicts graph with ≥1 contested
  // node. Every member — including a page that only got contradicted, not declaring it — is a
  // resolve-conflict item and is removed from independent trust classification.
  const inConflict = new Set();
  const components = [];
  const visited = new Set();
  for (const n of nodes) {
    if (visited.has(n.uid) || !contradicts.has(n.uid)) continue;
    const comp = [], stack = [n.uid];
    while (stack.length) { const u = stack.pop(); if (visited.has(u)) continue; visited.add(u); comp.push(u); for (const p of contradicts.get(u) || []) if (!visited.has(p)) stack.push(p); }
    if (comp.some((u) => (decided.get(u) || {}).conflict === "contested")) {
      for (const u of comp) inConflict.add(u);
      components.push(comp.sort((a, b) => (a < b ? -1 : 1)));
    }
  }

  // Order with each contested component COLLAPSED to one representative vertex — union its members'
  // rests_on edges — so the component sits after ALL its members' dependencies. (Positioning a component
  // at the minimum member position would place it before a dependency one of its members rests on.)
  const repOf = new Map(nodes.map((n) => [n.uid, n.uid]));
  for (const comp of components) for (const u of comp) repOf.set(u, comp[0]);
  const rep = (u) => repOf.get(u) || u;
  const mergedRestsOn = new Map();
  for (const [u, deps] of restsOn) {
    const ru = rep(u);
    if (!mergedRestsOn.has(ru)) mergedRestsOn.set(ru, new Set());
    for (const d of deps) { const rd = rep(d); if (rd !== ru) mergedRestsOn.get(ru).add(rd); }
  }
  const repUids = [...new Set(nodes.map((n) => rep(n.uid)))];
  const repPos = new Map(sccOrder(repUids, mergedRestsOn).map((u, i) => [u, i]));
  const posByUid = new Map(nodes.map((n) => [n.uid, repPos.get(rep(n.uid)) ?? 0]));
  const items = [];
  for (const comp of components) {
    // the actual contradiction edges within the component, as title pairs — a component of >2 pages is
    // resolved pair-by-pair (`gazette resolve` takes two), so the CLI must emit one command per pair.
    const memberSet = new Set(comp), pairs = [], seenPair = new Set();
    for (const u of comp) for (const p of contradicts.get(u) || []) if (memberSet.has(p)) {
      const [a, b] = [u, p].sort((x, y) => (x < y ? -1 : 1)), k = a + " " + b;
      if (!seenPair.has(k)) { seenPair.add(k); pairs.push([title(a), title(b)]); }
    }
    items.push({ kind: "resolve-conflict", uids: comp, titles: comp.map(title), why: WHY["resolve-conflict"], freshness: null, dependsOn: [], conflictPartners: comp, pairs, pos: Math.min(...comp.map((u) => posByUid.get(u) ?? 0)) });
  }
  for (const n of nodes) {
    if (inConflict.has(n.uid)) continue;
    const kind = baseKind(n.uid);
    if (!kind) continue;
    const deps = [...(restsOn.get(n.uid) || [])].sort((a, b) => (a < b ? -1 : 1));
    const bind = (kind === "approve" || kind === "reapprove") ? { digest: digestOf(n.uid) } : {};
    items.push({ kind, uids: [n.uid], titles: [title(n.uid)], why: WHY[kind], freshness: freshOf(n.uid), dependsOn: deps, conflictPartners: [], ...bind, pos: posByUid.get(n.uid) ?? 0 });
  }

  items.sort((a, b) => (a.pos - b.pos) || ((a.titles[0] || "") < (b.titles[0] || "") ? -1 : 1));
  const counts = {};
  for (const it of items) { counts[it.kind] = (counts[it.kind] || 0) + 1; delete it.pos; }
  return { items, counts };
}
