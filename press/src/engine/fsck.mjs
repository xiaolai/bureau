// engine/fsck - rebuild the MECHANICAL-DERIVED tier from (authored snapshot + decision log) to a
// byte-fixpoint, and report referential findings (roadmap §4.15, §7.3). LLM outputs are NOT in the
// fixpoint. Human/LLM decisions are verified PRESENT IN THE LOG, never rebuilt. The derived state is
// a pure function of its inputs - no clock, no randomness - so `build twice -> identical bytes` is a
// property, and `drop _gate.json -> rebuild -> identical` is the regenerability gate.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { loadCorpus, buildModel } from "../core/model.mjs";
import { canonicalJSON } from "../services/determinism.mjs";
import { logPath, readLog } from "./log.mjs";
import { projectRevisions } from "./revisions.mjs";
import { projectDecisions } from "./state.mjs";
import { computeGate } from "./gate.mjs";
import { scan } from "./scan.mjs";

export const GATE_BASENAME = "_gate.json";
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

// The ONE derived artifact: a canonical projection of (corpus + log). Everything mechanical the
// engine knows, in a byte-stable shape. Pure - identical inputs always yield identical bytes.
export function buildDerived({ model, events, schemaVersion = 1 }) {
  const spans = projectRevisions(events);
  const gate = computeGate({ model, events, schemaVersion });
  const revisions = [...spans.values()].filter((s) => s.alive).map((s) => ({ uid: s.uid, span: s.span, revision: s.revision })).sort((a, b) => (canonicalJSON([a.uid, a.span]) < canonicalJSON([b.uid, b.span]) ? -1 : 1));
  const edges = gate.edges.filter((e) => e.tracked && e.edgeId).map((e) => ({ edgeId: e.edgeId, dep: e.dep, target: e.target, span: e.span, verdictKey: e.verdictKey, open: e.open })).sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1));
  return {
    schemaVersion,
    freshness: [...gate.freshness.entries()].map(([uid, level]) => ({ uid, level })).sort((a, b) => (a.uid < b.uid ? -1 : 1)),
    dirty: gate.dirty,
    counts: gate.counts,
    revisions,
    edges,
  };
}

export const derivedDigest = (derived) => sha256(canonicalJSON(derived, 0));

// Full check. Loads the corpus (throws on a corpus-level error - a real finding), reads the log with
// integrity verification (throws on tamper), rebuilds the derived tier twice to prove the fixpoint,
// gathers referential findings, and refreshes the on-disk _gate.json cache. Returns a report.
export function fsck({ docsDir, schemaVersion = 1, write = true } = {}) {
  const corpus = loadCorpus({ docsDir });
  const model = buildModel({ corpus });
  const events = readLog(logPath(docsDir)); // strict: integrity failure throws here

  const d1 = buildDerived({ model, events, schemaVersion });
  const d2 = buildDerived({ model, events, schemaVersion });
  const digest1 = derivedDigest(d1), digest2 = derivedDigest(d2);
  const fixpointStable = digest1 === digest2;

  const findings = [];
  // the log is behind the corpus if a fresh scan would still have events to append
  const planned = scan({ docsDir, corpus, apply: false }).planned;
  if (planned.length) findings.push({ kind: "pending-scan", count: planned.length, detail: "run `gazette scan` - the log does not yet reflect the corpus" });

  // a confirm-edge that no current tracked edge matches is an orphan confirmation (dep/target changed)
  const liveEdgeIds = new Set(d1.edges.map((e) => e.edgeId));
  const confirmedIds = new Set();
  for (const ev of events) if (ev.type === "confirm-edge") confirmedIds.add(ev.edge);
  for (const eid of confirmedIds) if (!liveEdgeIds.has(eid)) findings.push({ kind: "orphan-confirm", edge: eid });

  // canonical is a PROJECTION of the log: an authored `canonical` with no approve event is unbacked
  const { approved } = projectDecisions(events);
  for (const n of Object.values(model.nodes)) {
    if ((n.trust || n.status) === "canonical" && !approved.has(n.uid)) findings.push({ kind: "unbacked-canonical", uid: n.uid, title: n.title });
  }
  findings.sort((a, b) => (canonicalJSON(a) < canonicalJSON(b) ? -1 : 1));

  // refresh the mechanical-derived cache; report drift vs the previous on-disk copy
  const gateFile = join(docsDir, GATE_BASENAME);
  const priorRaw = existsSync(gateFile) ? readFileSync(gateFile, "utf8") : null;
  const nextRaw = canonicalJSON(d1, 2) + "\n";
  const cacheDrift = priorRaw != null && priorRaw !== nextRaw;
  if (write) writeFileSync(gateFile, nextRaw);

  return { ok: fixpointStable && findings.length === 0, fixpointStable, digest: digest1, cacheDrift, findings, derived: d1, nodeCount: model.nodeCount };
}
