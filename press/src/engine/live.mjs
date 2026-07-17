// engine/live - freshness as the BOARD should show it: the committed decision log PLUS an overlay
// of the working tree's uncommitted span changes (a dry-run scan). So the rendered gazette reflects
// your edits LIVE - a changed upstream span shows its dependents as needs-review before you even
// `scan`. Deterministic given (files + committed log); it never writes the log.
import { buildModel } from "../core/model.mjs";
import { logPath, readLog, verifyIntegrity } from "./log.mjs";
import { computeGate } from "./gate.mjs";
import { scan } from "./scan.mjs";

// how prominent each level is (higher wins when a page qualifies for more than one)
const RANK = { current: 0, modified: 1, "needs-review": 2, stale: 3 };

export function liveFreshness({ corpus, docsDir, model }) {
  model = model || buildModel({ corpus });
  const dir = docsDir || (corpus && corpus.docsDir);
  const lf = logPath(dir);

  // Read the log tolerantly (the board must render even if the log is broken) but SURFACE a broken
  // chain rather than silently trusting it — fsck is the hard integrity gate; here we only warn.
  let committed = [], integrity = null;
  try {
    committed = readLog(lf, { verify: false });
    const v = verifyIntegrity(committed);
    if (!v.ok) integrity = v;
  } catch (e) { integrity = { ok: false, reason: e.message }; }
  if (integrity) return { byKey: new Map(), modified: new Set(), drift: [], pending: 0, counts: { needsReview: 0, stale: 0, modified: 0 }, integrity };

  // uncommitted working-tree changes (dry-run), applied as an OVERLAY on the committed log
  const planned = scan({ docsDir: dir, corpus, apply: false, events: committed }).planned;
  const effective = committed.slice();
  for (const p of planned) effective.push(p);
  const gate = computeGate({ model, events: effective });
  const modifiedUids = new Set(planned.map((p) => p.id)); // pages with an uncommitted own-span change

  // per-page level: the gate freshness, but a page you've just edited shows "modified" when the gate
  // has nothing stronger to say (a dependency signal always outranks your own uncommitted edit).
  const byKey = new Map();
  const level = new Map();
  for (const [uid, lvl] of gate.freshness) level.set(uid, lvl);
  for (const uid of modifiedUids) { const cur = level.get(uid) || "current"; if (RANK.modified > RANK[cur]) level.set(uid, "modified"); }
  const counts = { needsReview: 0, stale: 0, modified: 0 };
  for (const [uid, lvl] of level) {
    if (lvl === "current") continue;
    const key = corpus.keyByUid.get(uid);
    if (key) byKey.set(key, lvl);
    if (lvl === "needs-review") counts.needsReview++;
    else if (lvl === "stale") counts.stale++;
    else if (lvl === "modified") counts.modified++;
  }

  // drift rows for the board's Health page: every open tracked edge is a dependent sitting on a
  // changed or broken upstream span — the WHY behind a needs-review/stale badge.
  const drift = [];
  for (const e of gate.edges) {
    if (!e.tracked || !e.open) continue;
    drift.push({ page: corpus.keyByUid.get(e.dep) || e.dep, on: e.target, span: e.span || null, level: e.broken ? "stale" : "needs-review", reason: e.broken ? "broken dependency (target/span missing)" : "upstream span changed" });
  }
  drift.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  return { byKey, modified: modifiedUids, drift, pending: planned.length, counts, integrity: null };
}
