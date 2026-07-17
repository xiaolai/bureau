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

export function mutationGate({ docsDir, corpus } = {}) {
  const c = corpus || loadCorpus({ docsDir });
  const model = buildModel({ corpus: c });
  const uidByTitle = new Map(Object.values(model.nodes).map((n) => [n.id, n.uid]));

  // bring the log up to date IN MEMORY (scan dry-run), then confirm every open edge in memory so the
  // baseline is all-current. seq/ic are irrelevant to computeGate, which reads event fields only.
  let events = readLog(logPath(docsDir), { verify: false });
  for (const p of scan({ docsDir, corpus: c, apply: false }).planned) events.push(p);
  const base0 = computeGate({ model, events });
  for (const e of base0.edges) if (e.tracked && e.open && e.edgeId) events.push({ type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey });
  const base = computeGate({ model, events });

  let gateable = 0, killed = 0, untracked = 0;
  const survivors = [];
  for (const e of base.edges) {
    if (!e.tracked) { untracked++; survivors.push({ dep: e.dep, target: e.target, reason: "untracked-not-gated" }); continue; }
    if (e.broken) { survivors.push({ dep: e.dep, target: e.target, span: e.span, reason: "target-span-missing" }); continue; }
    if (base.freshness.get(e.dep) !== "current") { survivors.push({ dep: e.dep, target: e.target, span: e.span, reason: "dep-not-current-at-baseline" }); continue; }
    gateable++;
    const targetUid = uidByTitle.get(e.target);
    const mutant = events.concat([{ type: "edit", id: targetUid, span: e.span, hash: "MUTANT:" + e.edgeId }]);
    const gm = computeGate({ model, events: mutant });
    if (gm.freshness.get(e.dep) === "needs-review") killed++;
    else survivors.push({ dep: e.dep, target: e.target, span: e.span, reason: "survived-mutation" }); // a real wiring bug
  }
  survivors.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return { gateable, killed, killRate: gateable ? killed / gateable : null, untracked, survivors, note: MUTATION_NOTE };
}
