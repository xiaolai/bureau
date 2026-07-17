// engine/ledgers - the trust-critical ledgers, moved from LLM prompt-discipline to CODE (roadmap
// §4.16, the concrete answer to §0.1). `_verify.json` records artifact fingerprints; `_compile-
// state.json` the processed-session watermark. Both are mechanical-derived (in the fsck fixpoint).
// Artifact paths are JAILED inside a root: absolute paths, `..` escapes, and symlinks that leave the
// tree are rejected - the same zero-trust boundary the compile skill described in prose.
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, openSync, closeSync, fstatSync, readSync, constants } from "fs";
import { join, resolve, sep, isAbsolute } from "path";
import { createHash } from "crypto";
import { canonicalJSON } from "../services/determinism.mjs";
import { withLock } from "./log.mjs";

export const VERIFY_BASENAME = "_verify.json";
export const COMPILE_BASENAME = "_compile-state.json";

// a page-keyed map, rebuilt with a NULL prototype so a page literally named "__proto__" (or
// "constructor") is stored as an ordinary own key, never a prototype mutation.
const DANGEROUS_KEY = new Set(["__proto__", "prototype", "constructor"]);
function toNullProtoMap(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj)) out[k] = obj[k];
  return out;
}
function readJsonObject(file) {
  if (!existsSync(file)) return null;
  let v;
  try { v = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw new Error(file + " is not valid JSON: " + e.message); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(file + " must be a JSON object, not " + (Array.isArray(v) ? "an array" : typeof v));
  return v;
}
// atomic write (temp + rename) so a crashed writer can't leave a torn ledger.
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, canonicalJSON(obj, 2) + "\n");
  renameSync(tmp, file);
}

// Hash a file through a single fd opened O_NOFOLLOW on the (already realpath-resolved) target, and
// fstat-verify it — closing the check-to-use race where the FINAL path component is swapped for a
// symlink between validation and read. (A swap of an INTERMEDIATE directory to a symlink between
// realpath and open remains a residual TOCTOU; a full openat-per-component walk is out of scope for
// a local, non-adversarial dev tool in v0.7.) Reads in chunks so a large artifact doesn't balloon memory.
function hashJailed(realPath) {
  const fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("artifact is not a regular file: " + realPath);
    const h = createHash("sha256");
    const buf = Buffer.allocUnsafe(65536);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    return h.digest("hex");
  } finally { closeSync(fd); }
}

// Resolve `rel` under `root` and confirm the real path stays inside the real root - never follow a
// link out, never read an absolute/`..` path. Returns the verified (fully realpath'd) absolute path.
export function jailPath(root, rel) {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error("artifact path must be repo-relative with no `..`: " + rel);
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, rel);
  if (!existsSync(abs)) throw new Error("artifact not found: " + rel);
  const real = realpathSync(abs);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error("artifact path escapes the repo (symlink?): " + rel);
  if (!lstatSync(real).isFile()) throw new Error("artifact is not a regular file: " + rel);
  return real;
}

// ---- _verify.json (artifact fingerprints, keyed by page title) ----
// Validate every page entry: an object with a `checks` ARRAY whose items are {artifact, hash}. A
// malformed entry is a loud error (fsck surfaces it as `ledger-malformed`), never silently emptied.
function validateVerifyEntry(page, entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(VERIFY_BASENAME + ': entry for "' + page + '" must be an object');
  if (!Array.isArray(entry.checks)) throw new Error(VERIFY_BASENAME + ': entry for "' + page + '" must have a `checks` array');
  for (const c of entry.checks) if (c === null || typeof c !== "object" || typeof c.artifact !== "string" || typeof c.hash !== "string") throw new Error(VERIFY_BASENAME + ': a check under "' + page + '" must have string `artifact` and `hash`');
}
export function readVerify(workspaceDir) {
  const raw = readJsonObject(join(workspaceDir, VERIFY_BASENAME));
  if (!raw) return Object.create(null);
  const db = toNullProtoMap(raw);
  for (const page of Object.keys(db)) validateVerifyEntry(page, db[page]);
  return db;
}

// Fingerprint an artifact and upsert it under a page. `date` is caller-supplied (the log/clock owns
// time, not this module) so the write stays deterministic under a fixed clock. Returns the hash.
// The read-modify-write runs under a lock so concurrent verifications can't lose each other.
export function recordVerification(workspaceDir, { root, page, artifact, claim, date }) {
  if (typeof page !== "string" || !page) throw new Error("recordVerification needs a non-empty page title");
  const hash = hashJailed(jailPath(root, artifact));
  const file = join(workspaceDir, VERIFY_BASENAME);
  return withLock(file, () => {
    const db = readVerify(workspaceDir);
    const prior = Object.prototype.hasOwnProperty.call(db, page) && db[page] && typeof db[page] === "object" && !DANGEROUS_KEY.has(page) ? db[page] : null;
    const entry = prior || { verifiedAt: date || null, checks: [] };
    entry.verifiedAt = date || entry.verifiedAt || null;
    entry.checks = (Array.isArray(entry.checks) ? entry.checks : []).filter((c) => c.artifact !== artifact); // replace a prior check for the same artifact
    entry.checks.push({ artifact, hash, claim: claim || null });
    entry.checks.sort((a, b) => (a.artifact < b.artifact ? -1 : 1));
    db[page] = entry;
    writeJsonAtomic(file, db);
    return hash;
  });
}

// Re-hash every recorded artifact for a page and report drift - this is what turns `verified` into
// `stale` at review time (roadmap §4.16). A missing/escaped artifact is reported ok:false, never thrown.
export function recheckVerification(workspaceDir, { root, page }) {
  const db = readVerify(workspaceDir);
  const entry = Object.prototype.hasOwnProperty.call(db, page) ? db[page] : null;
  if (!entry || !Array.isArray(entry.checks)) return [];
  return entry.checks.map((c) => {
    let now = null, ok = false;
    try { now = hashJailed(jailPath(root, c.artifact)); ok = now === c.hash; } catch { ok = false; }
    return { artifact: c.artifact, was: c.hash, now, ok };
  });
}

// ---- _compile-state.json (processed-session watermark) ----
export function readCompiled(workspaceDir) {
  const db = readJsonObject(join(workspaceDir, COMPILE_BASENAME));
  if (!db) return new Set();
  if (db.compiled != null && !Array.isArray(db.compiled)) throw new Error(COMPILE_BASENAME + ': "compiled" must be an array');
  return new Set((db.compiled || []).map(String));
}
// Idempotent union - re-marking an already-compiled session is a no-op. Returns the count added.
// Locked read-modify-write so two concurrent compiles can't drop each other's entries.
export function markCompiled(workspaceDir, ids) {
  const file = join(workspaceDir, COMPILE_BASENAME);
  return withLock(file, () => {
    const set = readCompiled(workspaceDir);
    let added = 0;
    for (const id of (Array.isArray(ids) ? ids : [ids])) if (!set.has(String(id))) { set.add(String(id)); added++; }
    writeJsonAtomic(file, { compiled: [...set].sort() });
    return added;
  });
}
export function uncompiled(workspaceDir, allSessionIds) {
  const set = readCompiled(workspaceDir);
  return [...allSessionIds].map(String).filter((id) => !set.has(id));
}
