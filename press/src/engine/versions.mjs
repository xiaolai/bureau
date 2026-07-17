// engine/versions - git-backed board versioning (no new store). A git COMMIT already bundles a
// consistent {authored pages + _log.jsonl + ledgers}, so it IS the snapshot unit: `build --at <ref>`
// renders any past board via a detached worktree, and `diff` reads the decision-log slice between
// two refs to report what CHANGED (spans, decisions, artifact drift) from the source of truth.
// Node-only; shells out to git.
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { canonicalJSON } from "../services/determinism.mjs";

export const SNAPSHOTS_BASENAME = "_snapshots.json";
const gitText = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function resolveRef(root, ref) {
  try { return gitText(root, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]).trim(); }
  catch { throw new Error("not a valid git ref: " + ref); }
}
function showFile(root, ref, relPath) { try { return gitText(root, ["show", ref + ":" + relPath]); } catch { return null; } }
function parseLogText(raw) {
  if (!raw) return [];
  const out = [];
  for (const l of raw.split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip a non-JSON line */ } }
  return out;
}
const logHead = (events) => (events.length ? events[events.length - 1].seq : 0);

// Build the board AS OF a git ref, via a detached worktree (no tar dependency). `outDirAbs` must be
// an ABSOLUTE path in the LIVE repo, never inside the worktree. Returns the build summary. The
// worktree is always removed, even on failure.
export function buildAtRef({ root, ref, docsDirAbs, outDirAbs, now, buildSite }) {
  const sha = resolveRef(root, ref);
  const rel = relative(root, docsDirAbs);
  const parent = mkdtempSync(join(tmpdir(), "bureau-at-"));
  const wt = join(parent, "wt");
  try {
    execFileSync("git", ["-C", root, "worktree", "add", "--detach", "--quiet", wt, sha], { stdio: ["ignore", "ignore", "pipe"] });
    if (!existsSync(join(wt, rel))) throw new Error("content dir '" + rel + "' does not exist at " + ref + " (" + sha.slice(0, 8) + ")");
    return { ...buildSite({ root: wt, docsDir: join(wt, rel), outDir: outDirAbs, now, force: true }), ref, commit: sha };
  } finally {
    try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { stdio: "ignore" }); } catch { /* best effort */ }
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Semantic diff of the decision log between two refs. Assumes B extends A (the append-only common
// case): events in B past A's head are the change set. Reports the CHANGES from the source of truth
// plus artifact-fingerprint drift from _verify.json. `resolve` maps a snapshot NAME to a ref first.
export function logDiff({ root, refA, refB, docsDirAbs }) {
  const rel = relative(root, docsDirAbs);
  const shaA = resolveSnapshotOrRef({ root, docsDirAbs, ref: refA });
  const shaB = resolveSnapshotOrRef({ root, docsDirAbs, ref: refB });
  const a = parseLogText(showFile(root, shaA, rel + "/_log.jsonl"));
  const b = parseLogText(showFile(root, shaB, rel + "/_log.jsonl"));
  const aHead = logHead(a);
  const fresh = b.filter((e) => typeof e.seq === "number" && e.seq > aHead);
  const by = {};
  for (const e of fresh) (by[e.type] = by[e.type] || []).push(e);

  let va = {}, vb = {};
  try { va = JSON.parse(showFile(root, shaA, rel + "/_verify.json") || "{}"); } catch { /* absent/malformed → no drift */ }
  try { vb = JSON.parse(showFile(root, shaB, rel + "/_verify.json") || "{}"); } catch { /* */ }
  const artifactDrift = [];
  for (const page of Object.keys(vb)) {
    const mapA = new Map((((va[page] || {}).checks) || []).map((c) => [c.artifact, c.hash]));
    for (const c of ((vb[page] || {}).checks) || []) if (mapA.has(c.artifact) && mapA.get(c.artifact) !== c.hash) artifactDrift.push({ page, artifact: c.artifact });
  }
  return { commitA: shaA, commitB: shaB, fromSeq: aHead, toSeq: logHead(b), newEvents: fresh.length, by, artifactDrift };
}

// ---- named snapshots (a thin manifest pinning {commit, log-seq, digest} - reproducible by git) ----
function snapshotsPath(docsDirAbs) { return join(docsDirAbs, SNAPSHOTS_BASENAME); }
export function readSnapshots(docsDirAbs) {
  const p = snapshotsPath(docsDirAbs);
  if (!existsSync(p)) return [];
  try { const v = JSON.parse(readFileSync(p, "utf8")); return Array.isArray(v.snapshots) ? v.snapshots : []; }
  catch (e) { throw new Error(SNAPSHOTS_BASENAME + " is not valid JSON: " + e.message); }
}
// map a snapshot NAME to its pinned commit; if it isn't a known name, treat the string as a git ref.
export function resolveSnapshotOrRef({ root, docsDirAbs, ref }) {
  const snap = readSnapshots(docsDirAbs).find((s) => s.name === ref);
  return resolveRef(root, snap ? snap.commit : ref);
}
export function snapshotCreate({ root, docsDirAbs, name, note, digest }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name || ""))) throw new Error('snapshot name must match [A-Za-z0-9._-] (got: "' + name + '")');
  const snaps = readSnapshots(docsDirAbs);
  if (snaps.some((s) => s.name === name)) throw new Error('snapshot "' + name + '" already exists');
  const commit = gitText(root, ["rev-parse", "HEAD"]).trim();
  const events = parseLogText(existsSync(join(docsDirAbs, "_log.jsonl")) ? readFileSync(join(docsDirAbs, "_log.jsonl"), "utf8") : "");
  const entry = { name, commit, seq: logHead(events), digest: digest || null, note: note || null };
  snaps.push(entry);
  writeFileSync(snapshotsPath(docsDirAbs), canonicalJSON({ snapshots: snaps }, 2) + "\n");
  return entry;
}
