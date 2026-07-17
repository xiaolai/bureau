// engine/mutation - gate-WIRING mutation (roadmap §4.13a). For each tracked rests_on edge it
// mutates the target span (in memory) and checks the declared dependent fires. Kills "wired-wrong"
// faults. This is EXPLICITLY NOT a completeness measure - it can only exercise edges that already
// exist; an edge the author never declared cannot be mutated. Edge completeness is estimated
// separately by seeded recall (§4.13b, v0.8). Non-destructive: never writes the log.
import { loadCorpus, buildModel } from "../core/model.mjs";
import { logPath, readLog } from "./log.mjs";
import { scan } from "./scan.mjs";
import { computeGate } from "./gate.mjs";

export const MUTATION_NOTE = "measures gate WIRING adequacy only, NOT edge completeness (roadmap §4.13a)";

export function mutationGate({ docsDir, corpus, events } = {}) {
  const c = corpus || loadCorpus({ docsDir });
  const dir = docsDir || (c && c.docsDir);
  const model = buildModel({ corpus: c });
  const uidByTitle = new Map(Object.values(model.nodes).map((n) => [n.id, n.uid]));

  // bring the log up to date IN MEMORY (scan dry-run over the SAME snapshot when caller passed one),
  // then confirm every open, non-broken tracked edge so each gateable edge is CLOSED at baseline.
  const evs = Array.isArray(events) ? events.slice() : readLog(logPath(dir), { verify: false });
  for (const p of scan({ docsDir: dir, corpus: c, apply: false, events: evs }).planned) evs.push(p);
  const base0 = computeGate({ model, events: evs });
  for (const e of base0.edges) if (e.tracked && !e.broken && e.open && e.edgeId && e.verdictKey) evs.push({ type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey });
  const base = computeGate({ model, events: evs });

  let gateable = 0, killed = 0, untracked = 0;
  const survivors = [];
  for (const e of base.edges) {
    if (!e.tracked) { untracked++; survivors.push({ dep: e.dep, target: e.target, reason: e.reason === "downstream-unanchored" ? "downstream-unanchored" : "untracked-not-gated" }); continue; }
    if (e.broken) { survivors.push({ dep: e.dep, target: e.target, span: e.span, reason: "target-span-missing" }); continue; }
    // Evaluate THIS edge in isolation by its own open state — never page-level freshness, so an
    // unrelated broken/untracked edge on the same page can't exclude a valid edge here.
    if (e.open) { survivors.push({ dep: e.dep, target: e.target, span: e.span, reason: "not-closed-at-baseline" }); continue; }
    gateable++;
    const mutant = evs.concat([{ type: "edit", id: uidByTitle.get(e.target), span: e.span, hash: "MUTANT:" + e.edgeId }]);
    const mrow = computeGate({ model, events: mutant }).edges.find((x) => x.edgeId === e.edgeId);
    if (mrow && mrow.open) killed++;                                    // the edge reopened — wired right
    else survivors.push({ dep: e.dep, target: e.target, span: e.span, reason: "survived-mutation" }); // a real wiring bug
  }
  survivors.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return { gateable, killed, killRate: gateable ? killed / gateable : null, untracked, survivors, note: MUTATION_NOTE };
}
