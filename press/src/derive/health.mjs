// derive/health — the freshness/health surface (PRD §9). Pure, mechanical, no LLM.
// Deterministic given (model, now). Primitives (PRD §4 + grill H6):
//   - dangling : an edge whose target is no node (rename/typo) — links inside
//     <pre>/<code> are already excluded upstream in parse.parseHtmlDoc (grill H4)
//   - orphan   : a node with zero non-self in- AND out-edges (grill M12)
//   - contradiction (typed) : two nodes joined by a `contradicts:` edge
//   - invalidDate : `updated:` present but not a valid YYYY-MM-DD (grill H6 — a
//     typo'd date is a data-quality finding, not silently "no date")
//   - stale    : node.updated older than `now - window` AND some out-neighbor newer
//   - unsourced: a claim page (one carrying a trust tier) with NO provenance link into
//     the source drawer. Opt-in, via `_config.json`:
//         "provenance": { "requireFor": ["proposed","verified",…], "sourceGroup": "logbook" }
//     Without that block the lane is inert, so the generic press is unaffected. It exists
//     because a graph can be fully connected — zero dangling, zero orphans — while every
//     claim→source edge is missing: the source drawer links OUT to the pages, and nothing
//     checked the direction that actually carries the traceability guarantee.
//
// Deferred (documented): disk-vs-declared drift.

import { parseDate } from "../services/dates.mjs";
import { lintSchema } from "./schema.mjs";

const DAY = 86400000;

export function deriveHealth(model, backlinks, { now = null, staleWindowDays = 30, knownTargets = new Set() } = {}) {
  const nodes = model.nodes;
  const ids = new Set(Object.keys(nodes));
  const nowParsed = parseDate(now);

  // dangling — target resolves to no node AND no other known board doc.
  const dangling = [];
  for (const e of model.edges) {
    if (!ids.has(e.target) && !knownTargets.has(e.target)) {
      dangling.push({ source: e.source, target: e.target, edgeType: e.edgeType || null });
    }
  }

  // orphan — no non-self edges in or out (backlinks already excludes self-edges).
  const orphan = [];
  for (const id of ids) {
    if ((backlinks.outbound[id] || []).length === 0 && (backlinks.inbound[id] || []).length === 0) {
      orphan.push({ node: id });
    }
  }

  // contradiction — typed `contradicts:` edges, both ends present, deduped undirected.
  const seenPair = new Set();
  const contradiction = [];
  for (const e of model.edges) {
    if (e.edgeType !== "contradicts" || !ids.has(e.source) || !ids.has(e.target)) continue;
    const pair = [e.source, e.target].sort();
    const key = pair.join(" × ");
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    contradiction.push({ a: pair[0], b: pair[1] });
  }

  // invalidDate — `updated:` present but unparseable/rolled-over.
  const invalidDate = [];
  for (const id of ids) {
    const d = parseDate(nodes[id].updated);
    if (d.present && !d.valid) invalidDate.push({ node: id, updated: nodes[id].updated });
  }

  // neighborhood staleness — needs a valid `now` baseline.
  const stale = [];
  if (nowParsed.valid) {
    const cutoff = nowParsed.ts - staleWindowDays * DAY;
    for (const id of ids) {
      const u = parseDate(nodes[id].updated);
      if (!u.valid || u.ts >= cutoff) continue;
      let newest = null, newestTs = u.ts;
      for (const t of backlinks.outbound[id] || []) {
        const tu = parseDate(nodes[t] && nodes[t].updated);
        if (tu.valid && tu.ts > newestTs) { newest = t; newestTs = tu.ts; }
      }
      if (newest) stale.push({ node: id, updated: nodes[id].updated, newerNeighbor: newest });
    }
  }

  // unsourced — a claim page with no edge into the source drawer. Opt-in (see header).
  // A page IN the source drawer is its own provenance, so it is never required to cite one.
  // `exclude` names the drawer's index/overview pages: a prose link to the drawer's front
  // page ("see the [[Logbook]]") is NOT provenance for a claim, and letting it satisfy the
  // check would recreate the false all-clear this lane exists to prevent.
  const unsourced = [];
  const prov = (model.meta && model.meta.provenance) || null;
  const sourceGroup = prov && prov.sourceGroup != null ? String(prov.sourceGroup) : null;
  const requireFor = new Set(
    (prov && Array.isArray(prov.requireFor) ? prov.requireFor : []).map((s) => String(s).toLowerCase()),
  );
  const excluded = new Set(
    (prov && Array.isArray(prov.exclude) ? prov.exclude : []).map((s) => String(s).normalize("NFC")),
  );
  if (sourceGroup && requireFor.size) {
    const inDrawer = (id) => Object.prototype.hasOwnProperty.call(nodes, id) && nodes[id].group === sourceGroup;
    const isSource = (id) => inDrawer(id) && !excluded.has(id);
    for (const id of ids) {
      if (inDrawer(id)) continue;
      const status = nodes[id].status;
      if (!status || !requireFor.has(String(status).toLowerCase())) continue;
      if ((backlinks.outbound[id] || []).some(isSource)) continue;
      unsourced.push({ node: id, status: String(status) });
    }
  }

  // schema violations against declared `_types` (grill/plan gap: the linter)
  const schema = lintSchema(model, model.types);

  // disk-vs-declared drift: _config.meta.expectedDocs vs actual node count
  const drift = [];
  if (model.meta && model.meta.expectedDocs != null && Number(model.meta.expectedDocs) !== ids.size) {
    drift.push({ declared: Number(model.meta.expectedDocs), actual: ids.size });
  }

  const byJSON = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  dangling.sort(byJSON); orphan.sort(byJSON); contradiction.sort(byJSON);
  invalidDate.sort(byJSON); stale.sort(byJSON); schema.sort(byJSON); drift.sort(byJSON);
  unsourced.sort(byJSON);

  return {
    now,
    staleWindowDays,
    counts: {
      dangling: dangling.length,
      orphan: orphan.length,
      contradiction: contradiction.length,
      invalidDate: invalidDate.length,
      stale: stale.length,
      schema: schema.length,
      drift: drift.length,
      unsourced: unsourced.length,
    },
    dangling, orphan, contradiction, invalidDate, stale, schema, drift, unsourced,
  };
}

// Sum every lane. Derived from the object's own keys, not a hand-written addition chain —
// a hand-sum silently ignores any lane added later, which is how a lane can exist and still
// never make the check fail.
export function countsTotal(counts) {
  let n = 0;
  for (const v of Object.values(counts || {})) n += Number(v) || 0;
  return n;
}

export function healthTotal(health) {
  return countsTotal(health.counts);
}
