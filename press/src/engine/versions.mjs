// engine/versions - git-backed board versioning (no new store). A git COMMIT already bundles a
// consistent {authored pages + _log.jsonl + ledgers}, so it IS the snapshot unit: `build --at <ref>`
// renders any past board via a detached worktree, and `diff` reads the decision-log slice between
// two refs to report what CHANGED (spans, decisions, artifact drift) from the source of truth.
// Node-only; shells out to git. Paths are resolved relative to the GIT TOP-LEVEL (monorepo-safe) and
// normalized to forward slashes for git object paths.
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, lstatSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve, sep, isAbsolute } from "path";
import { canonicalJSON } from "../services/determinism.mjs";
import { verifyIntegrity, withLock } from "./log.mjs";

export const SNAPSHOTS_BASENAME = "_snapshots.json";
const GIT_MAXBUF = 64 * 1024 * 1024; // git-show a large decision log without ENOBUFS
const gitText = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAXBUF });

export function resolveRef(root, ref) {
  try { return gitText(root, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]).trim(); }
  catch { throw new Error("not a valid git ref: " + ref); }
}
// object path for `git show <ref>:<path>` — relative to the git TOP-LEVEL, forward-slashed, contained.
// Both sides are realpath'd so a symlinked temp/checkout root (e.g. macOS /var → /private/var) can't
// make a contained path look like it escapes.
function repoObjectPath(root, absPath) {
  const top = realpathSync(gitText(root, ["rev-parse", "--show-toplevel"]).trim());
  const rel = relative(top, realpathSync(resolve(absPath)));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path is outside the git repository: " + absPath);
  return rel.split(sep).join("/");
}
// git-show a file at a ref. Returns null ONLY when git RAN and exited non-zero (the path is absent
// at that ref). A buffer overflow, a spawn failure (git missing), a signal, or any other subprocess
// error is PROPAGATED — never masked as "absent" (which would silently suppress a diff / drift).
function showFile(root, ref, objectPath) {
  try { return gitText(root, ["show", ref + ":" + objectPath]); }
  catch (e) {
    if (e && e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("git show output exceeded " + GIT_MAXBUF + " bytes: " + objectPath);
    if (e && typeof e.status === "number") return null; // git ran and exited non-zero ⇒ path absent at this ref
    throw e; // spawn failure / signal / anything git didn't cleanly exit on ⇒ propagate
  }
}
// parse + INTEGRITY-VERIFY a historical decision log (strict: a corrupt history must never yield a
// falsely-clean diff). Throws on a malformed line or a broken chain.
function readLogAt(root, ref, objectPath) {
  const raw = showFile(root, ref, objectPath);
  if (!raw) return [];
  const events = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) { if (!lines[i].trim()) continue; try { events.push(JSON.parse(lines[i])); } catch (e) { throw new Error("decision log at " + ref.slice(0, 8) + " line " + (i + 1) + " is not valid JSON: " + e.message); } }
  const v = verifyIntegrity(events);
  if (!v.ok) throw new Error("decision log at " + ref.slice(0, 8) + " failed its integrity check at seq " + v.badSeq + ": " + v.reason);
  return events;
}
const logHead = (events) => (events.length ? events[events.length - 1].seq : 0);

// containment: does path `a` overlap path `b` (either direction)?
function overlaps(a, b) { const A = resolve(a), B = resolve(b); return A === B || A.startsWith(B + sep) || B.startsWith(A + sep); }
// is `child` the same as `parent` or nested under it?
function within(child, parent) { const C = resolve(child), P = resolve(parent); return C === P || C.startsWith(P + sep); }

// Build the board AS OF a git ref, via a detached worktree (no tar dependency). `outDirAbs` must be
// an ABSOLUTE path in the LIVE repo that does NOT overlap the live content/data dirs or repo root —
// guarded HERE, because buildSite only sees the temporary worktree. The worktree is always cleaned
// up (remove + prune), even on failure.
export function buildAtRef({ root, ref, docsDirAbs, dataDirAbs, outDirAbs, now, buildSite }) {
  const sha = resolveRef(root, ref);
  const objectPath = repoObjectPath(root, docsDirAbs);
  // never let a historical build overwrite live source
  if (overlaps(outDirAbs, docsDirAbs)) throw new Error("refusing build --at: --out overlaps the live content dir (" + docsDirAbs + ")");
  if (dataDirAbs && overlaps(outDirAbs, dataDirAbs)) throw new Error("refusing build --at: --out overlaps the live data dir (" + dataDirAbs + ")");
  if (within(root, outDirAbs)) throw new Error("refusing build --at: --out is the repo root or an ancestor of it (" + outDirAbs + ")"); // a normal subdir of root is fine

  const parent = mkdtempSync(join(tmpdir(), "bureau-at-"));
  const wt = join(parent, "wt");
  try {
    execFileSync("git", ["-C", root, "worktree", "add", "--detach", "--quiet", wt, sha], { stdio: ["ignore", "ignore", "pipe"] });
    const wtDocs = join(wt, ...objectPath.split("/"));
    if (!existsSync(wtDocs)) throw new Error("content dir '" + objectPath + "' does not exist at " + ref + " (" + sha.slice(0, 8) + ")");
    const wtData = dataDirAbs ? join(wt, ...objectPath.split("/"), "_data") : undefined; // historical data ships in the worktree
    return { ...buildSite({ root: wt, docsDir: wtDocs, dataDir: wtData, outDir: outDirAbs, now, force: true }), ref, commit: sha };
  } finally {
    try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { stdio: "ignore" }); } catch { /* removed below + pruned */ }
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ }
    try { execFileSync("git", ["-C", root, "worktree", "prune"], { stdio: "ignore" }); } catch { /* best effort */ } // drop any stale admin entry
  }
}

// Semantic diff of the decision log between two refs. REQUIRES B to extend A (A's integrity-verified
// log is an exact prefix of B's) — a reversed, truncated, or divergent history is rejected loudly,
// never reported as "no changes". Also reports artifact-fingerprint drift (added/removed/changed).
export function logDiff({ root, refA, refB, docsDirAbs }) {
  const objectPath = repoObjectPath(root, docsDirAbs);
  const shaA = resolveSnapshotOrRef({ root, docsDirAbs, ref: refA });
  const shaB = resolveSnapshotOrRef({ root, docsDirAbs, ref: refB });
  const a = readLogAt(root, shaA, objectPath + "/_log.jsonl");
  const b = readLogAt(root, shaB, objectPath + "/_log.jsonl");
  // A must be an exact append-only prefix of B (chain by integrity hash)
  if (a.length > b.length) throw new Error("cannot diff: " + refA + " has a longer log than " + refB + " (not an append-only extension — did you swap the order?)");
  for (let i = 0; i < a.length; i++) if (a[i].ic !== b[i].ic) throw new Error("cannot diff: the two histories diverge at seq " + (i + 1) + " (" + refA + " is not a prefix of " + refB + ")");
  const fresh = b.slice(a.length);
  const by = {};
  for (const e of fresh) (by[e.type] = by[e.type] || []).push(e);

  // artifact drift from _verify.json: absent ⇒ {} (no drift), MALFORMED ⇒ loud error (never masked)
  const readVerifyAt = (sha) => { const raw = showFile(root, sha, objectPath + "/_verify.json"); if (raw == null) return {}; try { return JSON.parse(raw); } catch (e) { throw new Error("_verify.json at " + sha.slice(0, 8) + " is malformed: " + e.message); } };
  const va = readVerifyAt(shaA), vb = readVerifyAt(shaB);
  const checkMap = (v, page) => new Map(((((v[page] || {}).checks) || [])).map((c) => [c.artifact, c.hash]));
  const artifactDrift = [];
  for (const page of new Set([...Object.keys(va), ...Object.keys(vb)])) {
    const ma = checkMap(va, page), mb = checkMap(vb, page);
    for (const [art, hb] of mb) { if (!ma.has(art)) artifactDrift.push({ page, artifact: art, kind: "added" }); else if (ma.get(art) !== hb) artifactDrift.push({ page, artifact: art, kind: "changed" }); }
    for (const art of ma.keys()) if (!mb.has(art)) artifactDrift.push({ page, artifact: art, kind: "removed" });
  }
  artifactDrift.sort((x, y) => (canonicalJSON(x) < canonicalJSON(y) ? -1 : canonicalJSON(x) > canonicalJSON(y) ? 1 : 0));
  return { commitA: shaA, commitB: shaB, fromSeq: logHead(a), toSeq: logHead(b), newEvents: fresh.length, by, artifactDrift };
}

// ---- named snapshots (a thin manifest pinning {commit, log-seq, digest} - reproducible by git) ----
function snapshotsPath(docsDirAbs) { return join(docsDirAbs, SNAPSHOTS_BASENAME); }
function validSnapshot(s) { return s && typeof s === "object" && !Array.isArray(s) && typeof s.name === "string" && typeof s.commit === "string" && s.commit.length >= 7; }
export function readSnapshots(docsDirAbs) {
  const p = snapshotsPath(docsDirAbs);
  if (!existsSync(p)) return [];
  let v;
  try { v = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(SNAPSHOTS_BASENAME + " is not valid JSON: " + e.message); }
  if (v === null || typeof v !== "object" || !Array.isArray(v.snapshots)) throw new Error(SNAPSHOTS_BASENAME + ' must be a JSON object with a "snapshots" array');
  for (const s of v.snapshots) if (!validSnapshot(s)) throw new Error(SNAPSHOTS_BASENAME + " has a malformed snapshot entry: " + canonicalJSON(s, 0));
  return v.snapshots;
}
// map a snapshot NAME to its pinned commit; if it isn't a known name, treat the string as a git ref.
export function resolveSnapshotOrRef({ root, docsDirAbs, ref }) {
  const snap = readSnapshots(docsDirAbs).find((s) => s.name === ref);
  return resolveRef(root, snap ? snap.commit : ref);
}
export function snapshotCreate({ root, docsDirAbs, name, note, digest }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name || ""))) throw new Error('snapshot name must match [A-Za-z0-9._-] (got: "' + name + '")');
  const objectPath = repoObjectPath(root, docsDirAbs);
  // A snapshot pins HEAD, so its seq/digest MUST describe HEAD's committed state — refuse a dirty
  // workspace where the SOURCE (pages/log/ledgers) differs from the commit. The `_snapshots.json`
  // manifest itself is excluded: writing it is what makes the tree "dirty", and it affects none of
  // {commit, seq, digest}.
  const dirty = gitText(root, ["status", "--porcelain", "--", objectPath]).split("\n")
    .filter((l) => l.trim() && !l.trimEnd().endsWith("/" + SNAPSHOTS_BASENAME));
  if (dirty.length) throw new Error("workspace has uncommitted changes — commit before snapshotting (a snapshot pins a commit):\n" + dirty.join("\n"));
  const file = snapshotsPath(docsDirAbs);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(SNAPSHOTS_BASENAME + " is a symlink (refused)");

  return withLock(file, () => {
    const snaps = readSnapshots(docsDirAbs);
    if (snaps.some((s) => s.name === name)) throw new Error('snapshot "' + name + '" already exists');
    const commit = gitText(root, ["rev-parse", "HEAD"]).trim();
    const committedLog = readLogAt(root, commit, objectPath + "/_log.jsonl"); // seq from the COMMIT, not the working tree
    const entry = { name, commit, seq: logHead(committedLog), digest: digest || null, note: note || null };
    snaps.push(entry);
    const tmp = file + ".tmp-" + process.pid;
    writeFileSync(tmp, canonicalJSON({ snapshots: snaps }, 2) + "\n");
    renameSync(tmp, file);
    return entry;
  });
}
