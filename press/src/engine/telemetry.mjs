// engine/telemetry - convergence telemetry (ADR-0001; roadmap §4.14). Makes §0.5 AUDITABLE: is the
// canon CONVERGING (the review queue drains between edit bursts, repeated firings trend to zero) or
// THRASHING (a page keeps re-entering the queue, the queue only grows)? It answers that from the one
// source of truth — the decision log — by DETERMINISTIC REPLAY, not a live per-run feed.
//
// Why replay, not a recorded _metrics feed: each observation recomputes the gate over a log PREFIX,
// so the whole series is a pure function of (model, log). That inherits the engine's byte-fixpoint
// reproducibility — no new committed artifact, no gitignore decision, no recorded-run that can drift
// from ground truth — and it can analyse the ENTIRE recorded history.
//
// HONEST SCOPE — this is a replay of the log's span-revision history against the CURRENT dependency
// topology, NOT a faithful reconstruction of what each past run actually saw. Edges (`rests_on`) live
// in page frontmatter, not the log, so adding/removing an edge or deleting a page reshapes the WHOLE
// series retroactively — it answers "given today's graph, how did the recorded churn play out?", a
// deterministic counterfactual, not a per-run archive. It also gives up wall-clock cadence (real time a
// page sat; runs that appended zero events). For "is the canon converging?" that scope is the right one
// — the recorded span events ARE the churn — but the verdict must never be sold as a historical audit.
//
// Convergence is NOT monotonic set-shrinkage (roadmap §0.5): independent edits grow the set, cycles
// give non-nested sets. The honest criterion is eventual stabilization under bounded per-run work.
// So this lane surfaces the RAW signals — per-run work, repeated firings, queue depth + age, and the
// early-cutoff ratio BESIDE the edge count — and a verdict that is ALWAYS printed beside those
// numbers, never alone (§4.14: a summary word that hides its own scope spends the trust that is the
// product). Pure: a function of (model, log events).
import { computeGate } from "./gate.mjs";
import { SCHEMA_VERSION } from "../core/model.mjs";
import { stripControl } from "../shared/escape.mjs";

const STRUCTURAL = new Set(["introduce", "edit", "rename", "split", "delete"]);
const isStructural = (ev) => STRUCTURAL.has(ev.type);

// A RUN is an edit-burst: a maximal contiguous block of structural (span) events between decision
// events — the reproducible analog of "a scan", and exactly the roadmap's unit ("the review queue
// drains between edit bursts"). A REVIEW is a maximal block of decision events (a queue drain).
// Partition the log into these alternating segments in seq order. Two back-to-back scans with no
// review between them merge into one burst — which is correct: no review happened, so the queue
// never drained; it is one continuous churn.
function segment(events) {
  const segs = [];
  let cur = null;
  for (const ev of events) {
    const kind = isStructural(ev) ? "scan" : "review";
    if (!cur || cur.kind !== kind) { cur = { kind, events: [] }; segs.push(cur); }
    cur.events.push(ev);
  }
  return segs;
}

// Thrash is judged over a bounded RECENT window, not the whole history: "repeated firings on unrelated
// churn trend to zero" (roadmap §0.5) is about the near term, so a canon that churned early and then
// stabilized must NOT read as thrashing forever. Within the last RECENT_WINDOW observations, a page
// that (re)entered the queue >= RECENT_REPEAT times is active churn. The window spans ~3 fire→drain
// cycles (each cycle is a scan + a review = 2 observations), enough to catch a real churn burst but
// short enough to forget old, settled churn.
const RECENT_WINDOW = 6;
const RECENT_REPEAT = 3;

export function projectTimeline({ model, events, schemaVersion = SCHEMA_VERSION }) {
  const segs = segment(events || []);
  const observations = [];
  const dirtySets = [];        // parallel to observations: Set<uid> dirty at each point (for age)
  const enteredSets = [];      // parallel: Set<uid> that (re)entered the queue at each point (for recent churn)
  const firings = new Map();   // uid -> LIFETIME count of (re)entries into the dirty set (reporting only)
  const workSamples = [];      // structural-event count per scan run (per-run work)
  let prevDirty = new Set();
  let runs = 0, reviews = 0, peakQueueDepth = 0;
  const prefix = [];

  // NOTE (cost): recomputing the gate over each growing prefix is O(segments × events). That is fine at
  // human-canon scale (hundreds of events) but is not free on every board build; an incremental fold of
  // revisions/confirmations at segment boundaries would make it linear if a large history ever needs it.
  for (const seg of segs) {
    for (const ev of seg.events) prefix.push(ev);
    const g = computeGate({ model, events: prefix, schemaVersion });
    const dirtyUids = new Set(g.dirty.map((d) => d.uid));
    // pages that newly entered the queue at this observation = a firing (not-dirty → dirty edge)
    const entered = new Set();
    for (const uid of dirtyUids) if (!prevDirty.has(uid)) { firings.set(uid, (firings.get(uid) || 0) + 1); entered.add(uid); }
    if (seg.kind === "scan") { runs++; workSamples.push(seg.events.length); } else reviews++;
    observations.push({
      atSeq: seg.events[seg.events.length - 1].seq,
      kind: seg.kind, work: seg.events.length,
      queueDepth: g.dirty.length, entered: entered.size,
      tracked: g.counts.tracked, open: g.counts.open, broken: g.counts.broken,
      cutoffRatio: g.cutoffRatio,
    });
    dirtySets.push(dirtyUids);
    enteredSets.push(entered);
    peakQueueDepth = Math.max(peakQueueDepth, g.dirty.length);
    prevDirty = dirtyUids;
  }

  // queue age: for each CURRENTLY-dirty page, its consecutive-dirty streak (in observations),
  // counting back from the last observation while it stays in every dirty set.
  const currentDirty = dirtySets.length ? dirtySets[dirtySets.length - 1] : new Set();
  const queueAge = [...currentDirty].map((uid) => {
    let age = 0;
    for (let i = dirtySets.length - 1; i >= 0 && dirtySets[i].has(uid); i--) age++;
    return { uid, age };
  }).sort((a, b) => b.age - a.age || (a.uid < b.uid ? -1 : 1));

  const firingList = [...firings.entries()].map(([uid, count]) => ({ uid, count }))
    .sort((a, b) => b.count - a.count || (a.uid < b.uid ? -1 : 1));
  const repeatedFirings = firingList.filter((f) => f.count >= 2).length;
  const maxFirings = firingList.reduce((m, f) => Math.max(m, f.count), 0);

  const perRunWork = workSamples.length
    ? { last: workSamples[workSamples.length - 1], max: Math.max(...workSamples), mean: workSamples.reduce((a, b) => a + b, 0) / workSamples.length }
    : { last: 0, max: 0, mean: 0 };

  // CURRENT state = the gate over the WHOLE log. This equals the last observation when there is history,
  // and — crucially — is still computed when there is NONE: a corpus with unconfirmed or broken edges but
  // no recorded scan is dirty NOW, so telemetry must not claim `drained` while the gate shows dirty pages.
  const fullGate = computeGate({ model, events: events || [], schemaVersion });
  const current = {
    queueDepth: fullGate.dirty.length, tracked: fullGate.counts.tracked, open: fullGate.counts.open,
    broken: fullGate.counts.broken, cutoffRatio: fullGate.cutoffRatio, dirty: fullGate.dirty.map((d) => d.uid).sort(),
  };
  const currentDepth = current.queueDepth;
  const n = observations.length;
  const queueGrowth = n >= 2 ? observations[n - 1].queueDepth - observations[n - 2].queueDepth : 0; // informational

  // RECENT churn: how many times each page re-entered the queue within the last RECENT_WINDOW
  // observations — the near-term signal, not the lifetime max (which never decays).
  const recentCounts = new Map();
  for (const s of enteredSets.slice(-RECENT_WINDOW)) for (const uid of s) recentCounts.set(uid, (recentCounts.get(uid) || 0) + 1);
  const recentMaxFirings = [...recentCounts.values()].reduce((m, v) => Math.max(m, v), 0);

  // SUSTAINED growth: the queue rose at EVERY step across the recent tail, never dropped, and net grew —
  // a genuine upward trend. This deliberately does NOT fire on [1,0,1] (a drain followed by one new
  // edit): that dips to 0, so it is bounded new work, not thrash.
  const tail = observations.slice(-RECENT_WINDOW).map((o) => o.queueDepth);
  const sustainedGrowth = tail.length >= 3 && tail[tail.length - 1] > 0 &&
    tail.every((d, i) => i === 0 || d >= tail[i - 1]) && tail[tail.length - 1] > tail[0];

  // Verdict — ALWAYS reported beside the raw numbers, never alone:
  //   thrashing   : a page re-fired >= RECENT_REPEAT times RECENTLY, or the queue is in sustained growth
  //   drained     : the queue is empty and nothing is recently thrashing — clean convergence
  //   stabilizing : outstanding work exists, but it is bounded and not trending up
  let verdict;
  if (recentMaxFirings >= RECENT_REPEAT || sustainedGrowth) verdict = "thrashing";
  else if (currentDepth === 0) verdict = "drained";
  else verdict = "stabilizing";

  return {
    schemaVersion, runs, reviews, observations,
    current,
    firings: firingList, repeatedFirings, maxFirings,
    queueAge, peakQueueDepth, perRunWork,
    stabilization: { verdict, currentDepth, queueGrowth, recentMaxFirings, maxFirings, sustainedGrowth, repeatedFirings },
  };
}

const pct = (r) => (r == null ? "n/a" : (r * 100).toFixed(1) + "%");

// Human-readable one-block render. `titleOf` (uid -> title) makes page references legible; without it
// the opaque uids are printed (still correct, just less friendly).
export function renderTimelineText(t, { titleOf } = {}) {
  // a page title is untrusted text; collapse control chars so it can't forge lines or inject ANSI into
  // the terminal (the shared sanitizer, also used by renderHealthText and the CLI).
  const name = (uid) => stripControl((titleOf && titleOf.get(uid)) || uid);
  const L = [];
  L.push("bureau convergence telemetry  (deterministic replay of the decision log — §4.14)");
  if (!t.observations.length) {
    L.push("  no history yet — edit a claim, run `gazette scan`, then confirm it in review to build a series");
    return L.join("\n");
  }
  L.push("  runs: " + t.runs + " edit-burst(s) · " + t.reviews + " review(s) · " + t.observations.length + " observation(s)");
  L.push("  per-run work: last " + t.perRunWork.last + " · max " + t.perRunWork.max + " · mean " + t.perRunWork.mean.toFixed(1) + " span-event(s)");
  L.push("  review queue: depth " + t.current.queueDepth + " (peak " + t.peakQueueDepth + ")" +
    (t.queueAge.length ? " · oldest " + t.queueAge[0].age + " observation(s)" : ""));
  L.push("  repeated firings: " + t.repeatedFirings + " page(s) re-entered the queue ≥2× (max " + t.maxFirings + "×)");
  L.push("  cutoff ratio " + pct(t.current.cutoffRatio) + " beside " + t.current.tracked + " tracked edge(s) · " +
    t.current.open + " open · " + t.current.broken + " broken  (never alone — §4.14)");
  const s = t.stabilization;
  const mark = s.verdict === "drained" ? "✅" : s.verdict === "stabilizing" ? "·" : "⚠";
  L.push("  " + mark + " " + s.verdict + " — depth " + s.currentDepth + ", tail growth " +
    (s.queueGrowth >= 0 ? "+" : "") + s.queueGrowth + ", max firings " + s.maxFirings);
  const churning = t.firings.filter((f) => f.count >= 2).slice(0, 5);
  if (churning.length) { L.push("  churning pages:"); for (const f of churning) L.push("    · " + name(f.uid) + " ×" + f.count); }
  const aged = t.queueAge.slice(0, 5);
  if (aged.length) { L.push("  outstanding (queue age):"); for (const a of aged) L.push("    · " + name(a.uid) + " — " + a.age + " observation(s)"); }
  return L.join("\n");
}
