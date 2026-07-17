// engine/metrics - the deterministic, AUDITABLE report (roadmap §4.15, §9.5). A first release that
// is "tested" but not auditable is not done. Emits gate-wiring kill rate, fsck fixpoint stability,
// and the gate accounting - with the early-cutoff ratio reported BESIDE edge count and dirty count,
// never alone (§4.14: a high cutoff ratio achieved by deleting edges is under-scoping in disguise).
// This is deterministic corpus measurement, NOT live telemetry (that is §4.14, v0.8).
import { loadCorpus, buildModel } from "../core/model.mjs";
import { logPath, readLog } from "./log.mjs";
import { computeGate } from "./gate.mjs";
import { fsck } from "./fsck.mjs";
import { mutationGate, MUTATION_NOTE } from "./mutation.mjs";

export function report({ docsDir, schemaVersion = 1 } = {}) {
  const corpus = loadCorpus({ docsDir });
  const model = buildModel({ corpus });
  const events = readLog(logPath(docsDir));
  const gate = computeGate({ model, events, schemaVersion });
  const f = fsck({ docsDir, schemaVersion, write: false });
  const m = mutationGate({ docsDir, corpus });

  return {
    nodeCount: model.nodeCount,
    fixpoint: { stable: f.fixpointStable, digest: f.digest },
    gate: {
      trackedEdges: gate.counts.tracked,
      untrackedEdges: gate.counts.untracked,
      openEdges: gate.counts.open,
      cutoffEdges: gate.counts.cutoff,
      brokenEdges: gate.counts.broken,
      cutoffRatio: gate.cutoffRatio, // reported beside trackedEdges + dirty - never in isolation
      dirtyPages: gate.dirty.length,
    },
    wiring: { gateable: m.gateable, killed: m.killed, killRate: m.killRate, survivors: m.survivors.length, note: MUTATION_NOTE },
    findings: f.findings,
    ok: f.ok && (m.killRate === null || m.killRate === 1),
  };
}

const pct = (r) => (r == null ? "n/a" : (r * 100).toFixed(1) + "%");
export function renderMetricsText(r) {
  const L = [];
  L.push("bureau engine metrics");
  L.push("  pages: " + r.nodeCount);
  L.push("  fixpoint: " + (r.fixpoint.stable ? "stable ✅" : "UNSTABLE ✗") + "  digest " + r.fixpoint.digest.slice(0, 12));
  L.push("  gate: " + r.gate.trackedEdges + " tracked edges · " + r.gate.dirtyPages + " dirty pages · cutoff ratio " + pct(r.gate.cutoffRatio) +
    " (beside edge-count, never alone) · " + r.gate.untrackedEdges + " untracked · " + r.gate.brokenEdges + " broken");
  L.push("  wiring kill rate: " + pct(r.wiring.killRate) + " (" + r.wiring.killed + "/" + r.wiring.gateable + ") — " + r.wiring.note);
  if (r.findings.length) { L.push("  findings:"); for (const f of r.findings) L.push("    · " + f.kind + (f.uid ? " " + f.uid : "") + (f.count ? " ×" + f.count : "")); }
  L.push(r.ok ? "  status: OK ✅" : "  status: needs attention ⚠");
  return L.join("\n");
}
