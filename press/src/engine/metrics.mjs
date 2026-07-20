// engine/metrics - the deterministic, AUDITABLE report (roadmap §4.15, §9.5). A first release that
// is "tested" but not auditable is not done. Emits gate-wiring kill rate, fsck fixpoint stability,
// and the gate accounting - with the early-cutoff ratio reported BESIDE edge count and dirty count,
// never alone (§4.14: a high cutoff ratio achieved by deleting edges is under-scoping in disguise).
// This is deterministic corpus measurement, NOT live telemetry (that is §4.14, v0.8).
import { loadCorpus, buildModel, SCHEMA_VERSION } from "../core/model.mjs";
import { logPath, readLog } from "./log.mjs";
import { computeGate } from "./gate.mjs";
import { fsck } from "./fsck.mjs";
import { mutationGate, MUTATION_NOTE } from "./mutation.mjs";
import { loadPolicy } from "./policy.mjs";

export function report({ docsDir, schemaVersion = SCHEMA_VERSION } = {}) {
  // ONE snapshot (corpus + integrity-verified log) threaded through every measurement, so gate,
  // fsck, and mutation can't mix inconsistent views (and the corpus is parsed once).
  const corpus = loadCorpus({ docsDir });
  const model = buildModel({ corpus });
  const events = readLog(logPath(docsDir));
  const policy = loadPolicy(docsDir); // the committed trust-authority policy, threaded into gate + fsck
  const gate = computeGate({ model, events, schemaVersion, policy });
  const f = fsck({ docsDir, corpus, events, schemaVersion, write: false, policy });
  // mutation is a STRUCTURAL wiring probe — it fabricates confirmations purely to close edges at
  // baseline, so it is policy-INDEPENDENT by design (subjecting its scaffolding to the authority
  // policy would break the measure under a non-human policy for no semantic gain).
  const m = mutationGate({ docsDir, corpus, events });

  const realSurvivors = m.survivors.filter((s) => s.reason === "survived-mutation").length;
  return {
    nodeCount: model.nodeCount,
    fixpoint: { stable: f.fixpointStable, digest: f.digest },
    policy: { approve: policy.approve, confirmEdge: policy["confirm-edge"], resolve: policy.resolve },
    gate: {
      trackedEdges: gate.counts.tracked,
      untrackedEdges: gate.counts.untracked,
      openEdges: gate.counts.open,
      cutoffEdges: gate.counts.cutoff,
      brokenEdges: gate.counts.broken,
      cutoffRatio: gate.cutoffRatio, // reported beside trackedEdges + dirty - never in isolation
      dirtyPages: gate.dirty.length,
    },
    wiring: { gateable: m.gateable, killed: m.killed, killRate: m.killRate, survivors: m.survivors.length, realSurvivors, note: MUTATION_NOTE },
    findings: f.findings,
    // OK requires: fixpoint stable + no blocking fsck findings + no broken (dangling) edges + no
    // edge that survived mutation (a real wiring bug). Untracked edges are a known CONSERVATIVE
    // limitation (they force needs-review), not a failure — so a fully-untracked graph is ok:true by
    // design; broken (dangling) edges, which ARE a defect, are what fail here.
    ok: f.ok && gate.counts.broken === 0 && realSurvivors === 0,
  };
}

const pct = (r) => (r == null ? "n/a" : (r * 100).toFixed(1) + "%");
export function renderMetricsText(r) {
  const L = [];
  L.push("bureau engine metrics");
  L.push("  pages: " + r.nodeCount);
  L.push("  fixpoint: " + (r.fixpoint.stable ? "stable ✅" : "UNSTABLE ✗") + "  digest " + r.fixpoint.digest.slice(0, 12));
  if (r.policy) {
    // report ALL THREE decisions — `resolve` was omitted, so a workspace accepting machine
    // resolution showed nothing about it in the "auditable" block.
    const line = "  trust policy: approve=[" + r.policy.approve.join(",") + "] · confirm-edge=[" +
      r.policy.confirmEdge.join(",") + "] · resolve=[" + r.policy.resolve.join(",") + "]";
    // per-decision, not "is the policy non-default": the canonical warning is about APPROVE. A
    // machine-only `confirm-edge` policy made the old check emit "canonical no longer implies a
    // human vouched", which was simply false.
    const machine = (k) => (r.policy[k] || []).some((a) => a !== "human");
    const notes = [];
    if (machine("approve")) notes.push("`canonical` no longer implies a human vouched");
    if (machine("confirmEdge")) notes.push("edge cutoffs may be machine-confirmed");
    if (machine("resolve")) notes.push("conflicts may be machine-resolved");
    L.push(line + (notes.length ? " — " + notes.join("; ") : " (human-only default)"));
  }
  L.push("  gate: " + r.gate.trackedEdges + " tracked edges · " + r.gate.dirtyPages + " dirty pages · cutoff ratio " + pct(r.gate.cutoffRatio) +
    " (beside edge-count, never alone) · " + r.gate.untrackedEdges + " untracked · " + r.gate.brokenEdges + " broken");
  L.push("  wiring kill rate: " + pct(r.wiring.killRate) + " (" + r.wiring.killed + "/" + r.wiring.gateable + ")" +
    (r.wiring.realSurvivors ? " · " + r.wiring.realSurvivors + " SURVIVED mutation ✗" : "") + " — " + r.wiring.note);
  if (r.gate.brokenEdges) L.push("  broken (dangling) edges: " + r.gate.brokenEdges + " ✗");
  if (r.findings.length) { L.push("  findings:"); for (const f of r.findings) L.push("    · " + f.kind + (f.uid ? " " + f.uid : "") + (f.count ? " ×" + f.count : "")); }
  L.push(r.ok ? "  status: OK ✅" : "  status: needs attention ⚠");
  return L.join("\n");
}
