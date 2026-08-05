// engine/fsck - rebuild the MECHANICAL-DERIVED tier from (authored snapshot + decision log) to a
// byte-fixpoint, and report referential findings (roadmap §4.15, §7.3). LLM outputs are NOT in the
// fixpoint. Human/LLM decisions are verified PRESENT IN THE LOG, never rebuilt. The derived state is
// a pure function of its inputs - no clock, no randomness - so `build twice -> identical bytes` is a
// property, and `drop _gate.json -> rebuild -> identical` is the regenerability gate.
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, openSync, closeSync, constants } from "fs";
import { join, dirname, resolve, basename } from "path";
import { createHash, randomBytes } from "crypto";
import { loadCorpus, buildModel, SCHEMA_VERSION } from "../core/model.mjs";
import { canonicalJSON } from "../services/determinism.mjs";
import { logPath, readLog } from "./log.mjs";
import { projectRevisions } from "./revisions.mjs";
import { projectDecisions, resolveNodeState } from "./state.mjs";
import { reviewDigest } from "./review-digest.mjs";
import { loadLegacy, isGrandfathered } from "./legacy.mjs";
import { computeGate } from "./gate.mjs";
import { scan } from "./scan.mjs";
import { readVerify, readCompiled } from "./ledgers.mjs";
import { loadPolicy, isAuthorized, policyMarker } from "./policy.mjs";
import { projectSupersessions } from "./supersede.mjs";

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
  // DEDUPED: a RECIPROCAL declaration (A `contradicts` B *and* B `contradicts` A) is ONE logical
  // conflict, but each edge adds the pair in both directions — so a plain array listed the same
  // partner twice, yielding duplicate resolution rows and (since the count was no longer 1) blanking
  // the singular `resolutionId`. Sorted on the way out to keep the derived tier order-independent.
  const add = (a, b) => { if (!partners.has(a)) partners.set(a, new Set()); partners.get(a).add(b); };
  for (const e of model.edges) {
    if (e.edgeType !== "contradicts") continue;
    const s = model.nodes[e.source], t = model.nodes[e.target];
    if (!s || !t) continue;
    add(s.uid, t.uid); add(t.uid, s.uid);
  }
  return new Map([...partners].map(([uid, set]) => [uid, [...set].sort()]));
}

// The ONE derived artifact: a canonical projection of (corpus + log). Everything mechanical the
// engine knows, in a byte-stable shape. Pure - identical inputs always yield identical bytes.
// Rewrite a page's leading frontmatter to set (value) or remove (value == null) exactly ONE key,
// leaving every other line and the whole body byte-identical. Returns the new text, or null when
// nothing would change / there is no frontmatter. Pure.
function setFrontmatterKey(text, key, value) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  let found = false, changed = false;
  const lines = m[1].split("\n").map((line) => {
    const i = line.indexOf(":");
    const k = i > 0 ? line.slice(0, i).trim() : null;
    if (k !== key) return line;
    found = true;
    if (value == null) { changed = true; return null; }          // remove the key
    const next = key + ": " + value;
    if (next !== line) changed = true;
    return next;
  }).filter((l) => l !== null);
  if (value != null && !found) { lines.push(key + ": " + value); changed = true; }
  if (!changed) return null;
  return "---\n" + lines.join("\n") + "\n---" + text.slice(m[0].length);
}

// Materialize the DERIVED effective-canonical tier into source pages as a non-authoritative
// `effective_status:` cache (ADR-0004 Decision C) — plain-file legibility for the log projection.
// Authored `status:` is NEVER touched; `effective_status: canonical` is written on effectively-
// canonical pages and removed elsewhere, so the cache tracks the log. Invoked ONLY under
// `fsck --materialize-pages`; a symlinked page is skipped and the write is atomic + O_NOFOLLOW.
function materializeEffectiveStatus(docsDir, entries, effCanon, supersededBy) {
  let changed = 0;
  for (const e of entries) {
    // BOTH derived-cache keys are in reviewDigest's NON_SEMANTIC_KEYS, so neither invalidates an
    // approval. `superseded_by` is a PLAIN-string list of the superseding page titles (never a
    // [[wiki-link]] — that would mint a phantom edge). Authoritatively rewritten/removed so a
    // spoofed hand-authored value is never trusted (ADR-0006).
    let next = e.raw;
    const a = setFrontmatterKey(next, "effective_status", effCanon.has(e.uid) ? "canonical" : null);
    if (a != null) next = a;
    const b = setFrontmatterKey(next, "superseded_by", supersededBy.get(e.uid) || null);
    if (b != null) next = b;
    if (next === e.raw) continue;                                // no change / no frontmatter
    const abs = join(docsDir, e.file);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue; // never write through a symlink
    const tmp = abs + ".bureau-mat-" + process.pid + "-" + randomBytes(6).toString("hex");
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, next); } finally { closeSync(fd); }
    renameSync(tmp, abs);
    changed++;
  }
  return changed;
}

export function buildDerived({ model, events, schemaVersion = SCHEMA_VERSION, policy = null }) {
  const spans = projectRevisions(events);
  const gate = computeGate({ model, events, schemaVersion, policy });
  // the policy is applied IN the projection: an approval/resolution the policy rejects never takes
  // effect, so no downstream consumer can read a tier an unaccepted authority granted.
  const decisions = projectDecisions(events, policy);
  const partners = conflictPartners(model);
  const revisions = [...spans.values()].filter((s) => s.alive).map((s) => ({ uid: s.uid, span: s.span, revision: s.revision })).sort((a, b) => (canonicalJSON([a.uid, a.span]) < canonicalJSON([b.uid, b.span]) ? -1 : 1));
  const edges = gate.edges.filter((e) => e.tracked && e.edgeId).map((e) => ({ edgeId: e.edgeId, dep: e.dep, target: e.target, span: e.span, verdictKey: e.verdictKey, open: e.open })).sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1));
  // decided state = the LOG projection (trust:canonical, conflict:resolved) per page. This is what
  // wires state.mjs into the derived tier so approvals/resolutions actually surface.
  const decided = Object.values(model.nodes).map((n) => {
    const st = resolveNodeState(n, decisions, partners.get(n.uid) || []);
    // trustBy = the authority class that backed the approval (null if unbacked); trustAuthorized =
    // whether the policy accepts it (vacuously true for a non-canonical tier — only canonical is gated
    // by the approve policy). Recorded here so `_gate.json` is self-describing under the active policy.
    const trustBy = decisions.approvedBy.get(n.uid) || null;
    const trustAuthorized = st.trust !== "canonical" || (trustBy != null && isAuthorized(policy, "approve", trustBy));
    // `resolutions` carries the per-conflict detail (winner + resolving authority) that a singular
    // `resolutionId` cannot represent for a page contradicting several others. Emitted only when the
    // page actually has conflicts, so a conflict-free corpus keeps its previous derived bytes.
    const rs = st.resolutions && st.resolutions.length ? { resolutions: st.resolutions } : {};
    return { uid: n.uid, trust: st.trust, trustBacked: st.trustBacked, trustBy, trustAuthorized, conflict: st.conflict, resolutionId: st.resolutionId ?? null, ...rs, freeze: st.freeze };
  }).sort((a, b) => (a.uid < b.uid ? -1 : 1));
  // The ACTIVE policy is part of what the derived tier attests: two DIFFERENT non-default policies
  // could otherwise yield identical bytes whenever the current events don't exercise their
  // difference, so the digest could not say which policy the rebuild ran under. Omitted entirely for
  // the default policy, which keeps default/all-human derived bytes byte-for-byte as before.
  const marker = policyMarker(policy);
  return {
    schemaVersion,
    ...(marker ? { policy: marker } : {}),
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
// Content-binding is now ENFORCED at the gate (ADR-0004): `stale-approval` — a content-bound approval
// whose page was edited after review — BLOCKS `fsck` (the approval no longer covers the current bytes,
// so the page must not stand as canonical fact until re-reviewed). Remediation is a re-approval
// (`gazette approve … --by human`, content-bound) or reverting the edit. Still ADVISORY (a nudge, not a
// hard failure): `unbound-approval` (a REAL human approval predating content-binding — legitimate, just
// not yet bound; re-approve or grandfather to bind it) and `legacy-canonical` (explicitly grandfathered
// via the Phase-6 manifest, voided on any change). `pending-scan` stays advisory (normal mid-edit).
const ADVISORY = new Set(["pending-scan", "unbound-approval", "legacy-canonical", "broken-supersedes", "supersedes-ineligible-target"]);

export function fsck({ docsDir, corpus, events, schemaVersion = SCHEMA_VERSION, write = true, policy, materializePages = false } = {}) {
  const c = corpus || loadCorpus({ docsDir });
  const model = buildModel({ corpus: c });
  const evs = events || readLog(logPath(docsDir)); // strict: integrity failure throws here (caller-supplied events are pre-verified)
  const pol = policy || loadPolicy(docsDir); // the committed trust-authority policy (human-only by default)

  const d1 = buildDerived({ model, events: evs, schemaVersion, policy: pol });
  const d2 = buildDerived({ model, events: evs, schemaVersion, policy: pol });
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
  // each ledger gets its OWN try — sharing one meant a malformed `_verify.json` short-circuited
  // before `_compile-state.json` was ever read, so a simultaneously-malformed second ledger went
  // unreported and "fix one, rerun, discover the next" was the only way to find them.
  for (const [name, read] of [["_verify.json", readVerify], ["_compile-state.json", readCompiled]]) {
    try { read(docsDir); }
    catch (e) { findings.push({ kind: "ledger-malformed", ledger: name, detail: e.message }); }
  }

  // a confirm-edge that no current tracked edge matches is an orphan confirmation (dep/target
  // changed); a live edge whose LAST confirmation was made by an authority the policy does not accept
  // is an unauthorized cutoff (e.g. an `invariant` confirm under a human-only policy) — the gate
  // already left the dependent needs-review; this surfaces WHY as a blocking finding.
  const liveEdgeIds = new Set(d1.edges.map((e) => e.edgeId));
  const lastConfirmBy = new Map(); // edgeId → raw `by` of its last confirm-edge (later supersedes)
  for (const ev of evs) if (ev.type === "confirm-edge") lastConfirmBy.set(ev.edge, ev.by);
  for (const [eid, by] of lastConfirmBy) {
    if (!liveEdgeIds.has(eid)) { findings.push({ kind: "orphan-confirm", edge: eid }); continue; }
    if (!isAuthorized(pol, "confirm-edge", by)) findings.push({ kind: "unauthorized-confirm", edge: eid, by: by ?? null, allowed: pol["confirm-edge"] });
  }

  // canonical is a PROJECTION of the log, gated by the trust-authority policy.
  //
  // The unauthorized checks key off the DECISION EVENT, never the page's AUTHORED tier. Keying off
  // the authored tier let a machine authority promote a page authored `proposed` straight to
  // `canonical` while this loop skipped it — a gate bypass that left `fsck.ok` true.
  const { approved, approvedHash, unauthorizedApprovals, unauthorizedResolutions, unauthorizedRejections } = projectDecisions(evs, pol);
  const nodeByUid = new Map(Object.values(model.nodes).map((n) => [n.uid, n]));

  // content-binding (ADR-0004): an EFFECTIVE approval that carries a `hash` is STALE if the page no
  // longer hashes to it (edited after review); an effective approval with NO hash is UNBOUND. The
  // LEGACY manifest (Phase 6) grandfathers an unbound/unbacked page at its current digest → the
  // advisory `legacy-canonical` instead. Advisory for now — the derived tier still projects the
  // approval (so no existing canon is demoted); enforcement is a later, migration-gated step.
  const rawByUid = new Map((c.entries || []).map((e) => [e.uid, e.raw]));
  const legacy = loadLegacy(docsDir);
  const digestCache = new Map();
  const digestFor = (uid) => {
    if (digestCache.has(uid)) return digestCache.get(uid);
    const raw = rawByUid.get(uid), n = nodeByUid.get(uid);
    let d = null; try { if (raw != null && n) d = reviewDigest({ raw, uid, title: n.title }); } catch { d = null; }
    digestCache.set(uid, d); return d;
  };
  for (const [uid, hash] of approvedHash) {
    const n = nodeByUid.get(uid);
    if (hash == null) {
      // real approve, no digest (predates content-binding): grandfathered if its current content is pinned.
      if (isGrandfathered(legacy, uid, digestFor(uid))) findings.push({ kind: "legacy-canonical", uid, title: n ? n.title : null });
      else findings.push({ kind: "unbound-approval", uid, title: n ? n.title : null });
      continue;
    }
    if (digestFor(uid) !== hash) findings.push({ kind: "stale-approval", uid, title: n ? n.title : null });
  }

  // an approve whose authority the policy rejects — it granted nothing, and that must be loud.
  for (const [uid, by] of unauthorizedApprovals) {
    const n = nodeByUid.get(uid);
    findings.push({ kind: "unauthorized-canonical", uid, title: n ? n.title : null, by, allowed: pol.approve });
  }
  // a reject whose authority the policy rejects — it revoked nothing (revocation reuses the `approve`
  // authority, ADR-0004), so a prior human approval still stands. Surface the inert attempt.
  for (const [uid, by] of unauthorizedRejections) {
    const n = nodeByUid.get(uid);
    findings.push({ kind: "unauthorized-reject", uid, title: n ? n.title : null, by, allowed: pol.approve });
  }
  // a resolve whose authority the policy rejects — the conflict stays contested.
  for (const [conflict, by] of unauthorizedResolutions) {
    findings.push({ kind: "unauthorized-resolve", conflict, by, allowed: pol.resolve });
  }
  // an authored `canonical` with NO approve event at all is unbacked (a rejected approval is
  // reported above as unauthorized instead, so a page never draws both findings).
  for (const n of Object.values(model.nodes)) {
    if ((n.trust || n.status) !== "canonical") continue;
    if (approved.has(n.uid) || unauthorizedApprovals.has(n.uid)) continue;
    // authored `canonical` with no approve event: grandfathered (advisory) if pinned at its current
    // digest, else unbacked (blocking) — a content change voids the grandfather and it blocks again.
    if (isGrandfathered(legacy, n.uid, digestFor(n.uid))) findings.push({ kind: "legacy-canonical", uid: n.uid, title: n.title });
    else findings.push({ kind: "unbacked-canonical", uid: n.uid, title: n.title });
  }

  // ── supersession projection (ADR-0006). `superseded` is a fsck-level state (like stale-approval),
  // NOT a buildDerived field: effectiveness gates on the source's FRESH (content-current) approval,
  // which needs raw bytes — so buildDerived is left untouched and the derived digest is byte-stable.
  // notEffBase = the PRE-supersession not-effective set (stale / unbacked / unauthorized / contested);
  // eligibleTargets = the pre-supersession effective-canonical set, computed BEFORE superseded is
  // subtracted (this breaks the circularity and lets contested win over supersession).
  const notEffBase = new Set();
  for (const f of findings) if ((f.kind === "stale-approval" || f.kind === "unbacked-canonical" || f.kind === "unauthorized-canonical") && f.uid != null) notEffBase.add(f.uid);
  for (const d of d1.decided) if (d.conflict === "contested") notEffBase.add(d.uid);
  const eligibleTargets = new Set();
  for (const d of d1.decided) if (d.trust === "canonical" && !notEffBase.has(d.uid)) eligibleTargets.add(d.uid);
  // fresh-approved sources: an effective approval that is content-CURRENT (bound AND its hash still
  // matches reviewDigest). A stale (hash mismatch) or unbound (hashless) approval is NOT fresh — so an
  // edit to the superseding ADR, or an unbound legacy approval, never silently demotes its target.
  const freshApprovedSources = new Set();
  for (const [uid, hash] of approvedHash) if (hash != null && digestFor(uid) === hash) freshApprovedSources.add(uid);
  const superseded = projectSupersessions({ model, approvedSources: freshApprovedSources, eligibleTargets });
  for (const cyc of superseded.cycles) findings.push({ kind: "supersedes-cycle", uids: cyc });                                  // blocking — a real contradiction
  for (const b of superseded.broken) findings.push({ kind: "broken-supersedes", sourceUid: b.sourceUid, target: b.target });    // advisory — dangling target
  for (const ig of superseded.ineligible) findings.push({ kind: "supersedes-ineligible-target", sourceUid: ig.sourceUid, targetUid: ig.targetUid }); // advisory — non-decision target
  findings.sort((a, b) => (canonicalJSON(a) < canonicalJSON(b) ? -1 : 1));

  // The EFFECTIVELY-canonical set: the derived tier projects `canonical`, and the gate does not flag
  // the backing as stale / unbacked / unauthorized / contested (notEffBase), NOR superseded by an
  // effective ADR (ADR-0006). Same rule readers use via `engine/effective.mjs`.
  const notEff = new Set(notEffBase);
  for (const uid of superseded.supersededBy.keys()) notEff.add(uid);
  const effCanon = new Set();
  for (const d of d1.decided) if (d.trust === "canonical" && !notEff.has(d.uid)) effCanon.add(d.uid);
  // opt-in ONLY: plain `gazette fsck` must never mutate a source page. `--materialize-pages` refreshes
  // the derived, non-authoritative `effective_status:` cache (authored `status:` untouched).
  let materialized = 0;
  // resolve the superseding uids → a plain-string title list per superseded page, for the reader marker.
  const supersededTitles = new Map();
  for (const [uid, byUids] of superseded.supersededBy) supersededTitles.set(uid, byUids.map((u) => (nodeByUid.get(u) ? nodeByUid.get(u).title : u)).join(", "));
  if (materializePages && write) materialized = materializeEffectiveStatus(c.docsDir || docsDir, c.entries, effCanon, supersededTitles);

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
  if (write) {
    mkdirSync(cacheDir, { recursive: true });
    // The temp file was `…tmp-<pid>` — PREDICTABLE, and opened with plain truncating semantics, so a
    // pre-created symlink at that path redirected the write to any file the user could write. Use an
    // unpredictable name and O_CREAT|O_EXCL|O_NOFOLLOW: exclusive creation fails if anything already
    // exists there, and O_NOFOLLOW refuses a symlink outright.
    const tmp = gateFile + ".tmp-" + process.pid + "-" + randomBytes(8).toString("hex");
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, nextRaw); } finally { closeSync(fd); }
    renameSync(tmp, gateFile);
  }

  const blockingFindings = findings.filter((f) => !ADVISORY.has(f.kind));
  return { ok: fixpointStable && blockingFindings.length === 0, fixpointStable, digest: digest1, cacheDrift, findings, blockingFindings, derived: d1, superseded: superseded.supersededBy, nodeCount: model.nodeCount, materialized };
}
