// engine/core — resolve an EXTERNAL bureau workspace from a USER-LOCAL mapping (ADR-0003).
//
// Threat model (Codex red-team, ADR-0003 Decision C/D): a code repo may be public and cloned by
// anyone, so a committed file must have ZERO authority to pick a filesystem target — otherwise a
// hostile repo could aim capture at another project's workspace under ~/bureaus and the compaction
// hook would read that logbook back into the session (a cross-project confidentiality leak). So the
// ONLY source of a path is the user's own ~/.config/bureau/workspaces.json; the code repo commits a
// path-FREE opaque `.bureau-id` that merely NAMES which workspace. An unmapped id is refused (the
// user must pair it explicitly) — never silently auto-mapped.
//
// Builtin-only (fs/path/os) on purpose: the standalone SessionEnd/SessionStart hooks import this
// with no node_modules, and the bundled CLI imports it too. Keep it dependency-free.
import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { homedir } from "os";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // opaque, path-free id (no separators, no dots-only)
const MARKER = "bureau.json";
const ID_FILE = ".bureau-id";

const safe = (fn, dflt = null) => { try { return fn(); } catch { return dflt; } };
const myUid = () => (typeof process.getuid === "function" ? process.getuid() : null);
// group/other WRITABLE is the plant risk (another user could inject entries / swap a target); read
// bits are not a write risk for a file of paths. Ownership is checked separately.
const groupOrOtherWritable = (mode) => (mode & 0o022) !== 0;

// ~/.config/bureau/workspaces.json (honors XDG_CONFIG_HOME when it is an absolute path).
export function configPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config");
  return join(base, "bureau", "workspaces.json");
}

// The exact command a user runs to pair an unmapped id (also printed by the hooks on refusal).
export function pairHint(id) {
  return "bureau:pair " + id + "  (adds " + id + " → <path> to " + configPath() + ")";
}

// Read the code-repo marker: a path-FREE opaque id, or null. A symlinked or path-shaped marker is
// rejected (null) — the id must be an opaque token, never a route to a filesystem location.
export function readBureauId(cwd) {
  const f = join(cwd, ID_FILE);
  if (!existsSync(f) || safe(() => lstatSync(f).isSymbolicLink(), false)) return null;
  const raw = safe(() => readFileSync(f, "utf8"));
  if (raw == null) return null;
  const id = raw.trim();
  return ID_RE.test(id) ? id : null;
}

function expandTilde(p) { return p === "~" ? homedir() : (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p); }

// The allowlist roots external workspaces may live under. Default: ~/bureaus (ADR-0003 convention).
// A user MAY add more via a top-level "roots": [absPaths] in the config. Every root is realpath'd;
// unresolvable ones are dropped.
function allowlistRoots(rawConfig) {
  const wanted = [join(homedir(), "bureaus")];
  if (rawConfig && Array.isArray(rawConfig.roots)) for (const r of rawConfig.roots) if (typeof r === "string" && r) wanted.push(expandTilde(r));
  const out = [];
  for (const r of wanted) { const rp = safe(() => realpathSync(resolve(r))); if (rp) out.push(rp); }
  return out;
}

// Load + VALIDATE the user-local mapping. Throws on an INSECURE config (symlink, foreign-owned, or
// group/other-writable) so a planted/looser file can't silently steer writes. Absent → present:false.
export function loadWorkspaceMap() {
  const f = configPath();
  if (!existsSync(f)) return { entries: {}, raw: {}, present: false };
  if (safe(() => lstatSync(f).isSymbolicLink(), false)) throw new Error(configPath() + " is a symlink (refused)");
  const st = safe(() => statSync(f));
  if (!st) throw new Error("cannot stat " + configPath());
  const uid = myUid();
  if (uid != null && st.uid !== uid) throw new Error(configPath() + " is not owned by the current user (refused)");
  if (groupOrOtherWritable(st.mode)) throw new Error(configPath() + " is group/other-writable — run `chmod 600 " + configPath() + "`");
  const v = safe(() => JSON.parse(readFileSync(f, "utf8")));
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw new Error(configPath() + " must be a JSON object");
  const entries = (v.workspaces && typeof v.workspaces === "object" && !Array.isArray(v.workspaces)) ? v.workspaces : {};
  return { entries, raw: v, present: true };
}

// Validate a mapped target path against every control before it is ever written to. Exported so the
// pairing helper (`scripts/pair.mjs`) applies the EXACT same controls when it records a new entry.
export function validateWorkspaceTarget(rawPath, rawConfig) {
  const p = resolve(expandTilde(String(rawPath)));
  if (!existsSync(p)) return { ok: false, reason: "mapped workspace does not exist: " + p };
  if (safe(() => lstatSync(p).isSymbolicLink(), false)) return { ok: false, reason: "mapped workspace is a symlink (refused): " + p };
  const real = safe(() => realpathSync(p));
  if (!real) return { ok: false, reason: "cannot resolve mapped workspace: " + p };
  const roots = allowlistRoots(rawConfig);
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) return { ok: false, reason: "mapped workspace is outside the allowed roots [" + roots.join(", ") + "]: " + real };
  const markerPath = join(real, MARKER); // the marker must be a REAL regular file, not a symlink/dir/fifo
  if (!existsSync(markerPath) || safe(() => lstatSync(markerPath).isSymbolicLink(), true) || !safe(() => statSync(markerPath).isFile(), false)) return { ok: false, reason: "mapped path has no real " + MARKER + " marker (not a workspace): " + real };
  const st = safe(() => statSync(real));
  if (!st) return { ok: false, reason: "cannot stat mapped workspace: " + real };
  const uid = myUid();
  if (uid != null && st.uid !== uid) return { ok: false, reason: "mapped workspace is not owned by the current user (refused): " + real };
  if (groupOrOtherWritable(st.mode)) return { ok: false, reason: "mapped workspace is group/other-writable — run `chmod 755 " + real + "`" };
  return { ok: true, dir: real };
}

// Resolve the workspace for a repo `cwd`. One of:
//   { mode: "in-repo" }                 — no .bureau-id; caller uses the in-tree bureau.json scan
//   { mode: "external", dir, id }       — a validated external workspace, safe to write to
//   { mode: "unpaired", id, hint }      — .bureau-id present but not mapped → caller MUST refuse + tell the user
//   { mode: "rejected", id, reason }    — mapped but failed a security/existence check → caller MUST refuse
// The caller NEVER falls back to the cwd tree for unpaired/rejected — that would silently mis-file.
export function resolveWorkspace(cwd) {
  const id = readBureauId(cwd);
  if (!id) {
    // Fail CLOSED, not open: distinguish "no marker" (genuine in-repo) from "marker present but
    // invalid / unreadable / symlinked". A malformed .bureau-id must be REJECTED — never silently
    // fall through to in-tree discovery (which could mis-file into an unrelated cwd workspace).
    if (existsSync(join(cwd, ID_FILE))) return { mode: "rejected", id: null, reason: ".bureau-id is present but not a valid opaque token (must be a real file holding one [A-Za-z0-9._-] id)" };
    return { mode: "in-repo" };
  }
  let loaded;
  try { loaded = loadWorkspaceMap(); } catch (e) { return { mode: "rejected", id, reason: e.message }; }
  const entry = loaded.entries[id];
  if (!entry || typeof entry.path !== "string") return { mode: "unpaired", id, hint: pairHint(id) };
  const check = validateWorkspaceTarget(entry.path, loaded.raw);
  if (!check.ok) return { mode: "rejected", id, reason: check.reason };
  return { mode: "external", dir: check.dir, id };
}
