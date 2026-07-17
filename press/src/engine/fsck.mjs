// engine/fsck - rebuild the MECHANICAL-DERIVED tier from (authored snapshot + decision log) to a
// byte-fixpoint, and report referential findings (roadmap §4.15, §7.3). LLM outputs are NOT in the
// fixpoint. Human/LLM decisions are verified PRESENT IN THE LOG, never rebuilt. The derived state is
// a pure function of its inputs - no clock, no randomness - so `build twice -> identical bytes` is a
// property, and `drop _gate.json -> rebuild -> identical` is the regenerability gate.
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { createHash } from "crypto";
import { loadCorpus, buildModel, SCHEMA_VERSION } from "../core/model.mjs";
import { canonicalJSON } from "../services/determinism.mjs";
import { logPath, readLog } from "./log.mjs";
import { projectRevisions } from "./revisions.mjs";
import { projectDecisions, resolveNodeState } from "./state.mjs";
import { computeGate } from "./gate.mjs";
import { scan } from "./scan.mjs";
import { readVerify, readCompiled } from "./ledgers.mjs";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
// The gate cache is DERIVED state, so it lives OUTSIDE the workspace — in a sibling `.bureau-cache/`
// (gitignored at the repo root) — keeping the workspace to source + committed decisions only, zero
// derived files. It is regenerable (drop it → `fsck` rebuilds identical bytes), never committed. The
// filename is NAMESPACED per-workspace (basename + a hash of the resolved path) so two content dirs
// sharing a parent never overwrite each other's cache.
export const GATE_CACHE_DIR = ".bureau-cache";
export function gateCachePath(docsDir) {
  const abs = resolve(docsDir);
  const tag = basename(abs).replace(/[^A-Za-z0-9._-]/g, "_") + "-" + sha256(abs).slice(0, 8);
  return join(dirname(abs), GATE_CACHE_DIR, tag + ".json");
}

// contradicts partners per uid (both directions), for the conflict projection.
function conflictPartners(model) {
  const partners = new Map();
  const add = (a, b) => { if (!partners.has(a)) partners.set(a, []); partners.get(a).push(b); };
  for (const e of model.edges) {
    if (e.edgeType !== "contradicts") continue;
    const s = model.nodes[e.source], t = model.nodes[e.target];
    if (!s || !t) continue;
    add(s.uid, t.uid); add(t.uid, s.uid);
  }
  return partners;
}

// The ONE derived artifact: a canonical projection of (corpus + log). Everything mechanical the
// engine knows, in a byte-stable shape. Pure - identical inputs always yield identical bytes.
export function buildDerived({ model, events, schemaVersion = SCHEMA_VERSION }) {
  const spans = projectRevisions(events);
  const gate = computeGate({ model, events, schemaVersion });
  const decisions = projectDecisions(events);
  const partners = conflictPartners(model);
  const revisions = [...spans.values()].filter((s) => s.alive).map((s) => ({ uid: s.uid, span: s.span, revision: s.revision })).sort((a, b) => (canonicalJSON([a.uid, a.span]) < canonicalJSON([b.uid, b.span]) ? -1 : 1));
  const edges = gate.edges.filter((e) => e.tracked && e.edgeId).map((e) => ({ edgeId: e.edgeId, dep: e.dep, target: e.target, span: e.span, verdictKey: e.verdictKey, open: e.open })).sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1));
  // decided state = the LOG projection (trust:canonical, conflict:resolved) per page. This is what
  // wires state.mjs into the derived tier so approvals/resolutions actually surface.
  const decided = Object.values(model.nodes).map((n) => {
    const st = resolveNodeState(n, decisions, partners.get(n.uid) || []);
    return { uid: n.uid, trust: st.trust, trustBacked: st.trustBacked, conflict: st.conflict, resolutionId: st.resolutionId ?? null, freeze: st.freeze };
  }).sort((a, b) => (a.uid < b.uid ? -1 : 1));
  return {
    schemaVersion,
    freshness: [...gate.freshness.entries()].map(([uid, level]) => ({ uid, level })).sort((a, b) => (a.uid < b.uid ? -1 : 1)),
    dirty: gate.dirty,
    counts: gate.counts,
    revisions,
    edges,
    decided,
  };
}

export const derivedDigest = (derived) => sha256(canonicalJSON(derived, 0));

// Full check. Loads the corpus (throws on a corpus-level error - a real finding), reads the log with
// integrity verification (throws on tamper), rebuilds the derived tier twice to prove the fixpoint,
// gathers referential findings, and refreshes the on-disk _gate.json cache. Returns a report.
// Findings are graded: `pending-scan` is ADVISORY (editing without re-scanning is normal mid-work);
// everything else is a real problem. `ok` (and the CLI exit) turn only on the non-advisory findings
// plus fixpoint stability — so a clean, scanned canon is ok:true even before the next scan.
const ADVISORY = new Set(["pending-scan"]);

export function fsck({ docsDir, corpus, events, schemaVersion = SCHEMA_VERSION, write = true } = {}) {
  const c = corpus || loadCorpus({ docsDir });
  const model = buildModel({ corpus: c });
  const evs = events || readLog(logPath(docsDir)); // strict: integrity failure throws here (caller-supplied events are pre-verified)

  const d1 = buildDerived({ model, events: evs, schemaVersion });
  const d2 = buildDerived({ model, events: evs, schemaVersion });
  const digest1 = derivedDigest(d1), digest2 = derivedDigest(d2);
  const fixpointStable = digest1 === digest2;

  const findings = [];
  // the log is behind the corpus if a fresh scan would still have events to append. Pass the
  // already-read events so the dry-run diffs the SAME snapshot the derived tier was built from.
  const planned = scan({ docsDir, corpus: c, apply: false, events: evs }).planned;
  if (planned.length) findings.push({ kind: "pending-scan", count: planned.length, detail: "run `gazette scan` - the log does not yet reflect the corpus" });

  // the trust ledgers are INPUTS (authored/decided), not part of the byte-fixpoint (they record
  // filesystem fingerprints + a compile watermark, neither derivable from the log). fsck verifies
  // they are well-formed rather than rebuilding them (ADR-0001, §2.3, corrected).
  try { readVerify(docsDir); readCompiled(docsDir); }
  catch (e) { findings.push({ kind: "ledger-malformed", detail: e.message }); }

  // a confirm-edge that no current tracked edge matches is an orphan confirmation (dep/target changed)
  const liveEdgeIds = new Set(d1.edges.map((e) => e.edgeId));
  const confirmedIds = new Set();
  for (const ev of evs) if (ev.type === "confirm-edge") confirmedIds.add(ev.edge);
  for (const eid of confirmedIds) if (!liveEdgeIds.has(eid)) findings.push({ kind: "orphan-confirm", edge: eid });

  // canonical is a PROJECTION of the log: an authored `canonical` with no approve event is unbacked
  const { approved } = projectDecisions(evs);
  for (const n of Object.values(model.nodes)) {
    if ((n.trust || n.status) === "canonical" && !approved.has(n.uid)) findings.push({ kind: "unbacked-canonical", uid: n.uid, title: n.title });
  }
  findings.sort((a, b) => (canonicalJSON(a) < canonicalJSON(b) ? -1 : 1));

  // refresh the mechanical-derived cache (OUTSIDE the workspace); report drift vs the previous copy.
  // Reject a symlinked cache dir/file (a swap could redirect the write) and write atomically.
  const gateFile = gateCachePath(docsDir);
  const cacheDir = dirname(gateFile);
  const isLink = (p) => existsSync(p) && lstatSync(p).isSymbolicLink();
  if (isLink(cacheDir)) throw new Error("gate cache dir is a symlink (refused): " + cacheDir);
  if (isLink(gateFile)) throw new Error("gate cache file is a symlink (refused): " + gateFile);
  const priorRaw = existsSync(gateFile) ? readFileSync(gateFile, "utf8") : null;
  const nextRaw = canonicalJSON(d1, 2) + "\n";
  const cacheDrift = priorRaw != null && priorRaw !== nextRaw;
  if (write) { mkdirSync(cacheDir, { recursive: true }); const tmp = gateFile + ".tmp-" + process.pid; writeFileSync(tmp, nextRaw); renameSync(tmp, gateFile); }

  const blockingFindings = findings.filter((f) => !ADVISORY.has(f.kind));
  return { ok: fixpointStable && blockingFindings.length === 0, fixpointStable, digest: digest1, cacheDrift, findings, blockingFindings, derived: d1, nodeCount: model.nodeCount };
}
