// engine/ledgers - the trust-critical ledgers, moved from LLM prompt-discipline to CODE (roadmap
// §4.16, the concrete answer to §0.1). `_verify.json` records artifact fingerprints; `_compile-
// state.json` the processed-session watermark. Both are mechanical-derived (in the fsck fixpoint).
// Artifact paths are JAILED inside a root: absolute paths, `..` escapes, and symlinks that leave the
// tree are rejected - the same zero-trust boundary the compile skill described in prose.
import { existsSync, readFileSync, writeFileSync, realpathSync, lstatSync } from "fs";
import { join, resolve, sep, isAbsolute } from "path";
import { createHash } from "crypto";
import { canonicalJSON } from "../services/determinism.mjs";

export const VERIFY_BASENAME = "_verify.json";
export const COMPILE_BASENAME = "_compile-state.json";
const sha256File = (abs) => createHash("sha256").update(readFileSync(abs)).digest("hex");

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" ? v : fallback; }
  catch (e) { throw new Error(file + " is not valid JSON: " + e.message); }
}
const writeJson = (file, obj) => writeFileSync(file, canonicalJSON(obj, 2) + "\n");

// Resolve `rel` under `root` and confirm the real path stays inside the real root - never follow a
// link out, never read an absolute/`..` path. Returns the verified absolute path. Mirrors
// model.safeDocPath's posture.
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
export function readVerify(workspaceDir) { return readJson(join(workspaceDir, VERIFY_BASENAME), {}); }

// Fingerprint an artifact and upsert it under a page. `date` is caller-supplied (the log/clock owns
// time, not this module) so the write stays deterministic under a fixed clock. Returns the hash.
export function recordVerification(workspaceDir, { root, page, artifact, claim, date }) {
  const abs = jailPath(root, artifact);
  const hash = sha256File(abs);
  const db = readVerify(workspaceDir);
  const entry = db[page] && typeof db[page] === "object" ? db[page] : { verifiedAt: date || null, checks: [] };
  entry.verifiedAt = date || entry.verifiedAt || null;
  entry.checks = (entry.checks || []).filter((c) => c.artifact !== artifact); // replace a prior check for the same artifact
  entry.checks.push({ artifact, hash, claim: claim || null });
  entry.checks.sort((a, b) => (a.artifact < b.artifact ? -1 : 1));
  db[page] = entry;
  writeJson(join(workspaceDir, VERIFY_BASENAME), db);
  return hash;
}

// Re-hash every recorded artifact for a page and report drift - this is what turns `verified` into
// `stale` at review time (roadmap §4.16). A missing/escaped artifact is reported ok:false, never thrown.
export function recheckVerification(workspaceDir, { root, page }) {
  const db = readVerify(workspaceDir);
  const entry = db[page];
  if (!entry || !Array.isArray(entry.checks)) return [];
  return entry.checks.map((c) => {
    let now = null, ok = false;
    try { now = sha256File(jailPath(root, c.artifact)); ok = now === c.hash; } catch { ok = false; }
    return { artifact: c.artifact, was: c.hash, now, ok };
  });
}

// ---- _compile-state.json (processed-session watermark) ----
export function readCompiled(workspaceDir) {
  const db = readJson(join(workspaceDir, COMPILE_BASENAME), { compiled: [] });
  return new Set(Array.isArray(db.compiled) ? db.compiled.map(String) : []);
}
// Idempotent union - re-marking an already-compiled session is a no-op. Returns the count added.
export function markCompiled(workspaceDir, ids) {
  const set = readCompiled(workspaceDir);
  let added = 0;
  for (const id of (Array.isArray(ids) ? ids : [ids])) if (!set.has(String(id))) { set.add(String(id)); added++; }
  writeJson(join(workspaceDir, COMPILE_BASENAME), { compiled: [...set].sort() });
  return added;
}
export function uncompiled(workspaceDir, allSessionIds) {
  const set = readCompiled(workspaceDir);
  return [...allSessionIds].map(String).filter((id) => !set.has(id));
}
