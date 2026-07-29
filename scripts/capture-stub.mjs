#!/usr/bin/env node
// bureau capture-stub — the SessionEnd safety net. A hook is a shell command, so it can
// do NO LLM work; this writes a purely mechanical logbook stub so no session is ever lost.
// The rich entry (intent, decisions, narrative) is written by `bureau:file-session` DURING a
// session, where the agent still has full context.
//
// Hard contract: purely mechanical, NEVER throw, NEVER block session end, and do NOTHING
// unless the cwd is a real bureau workspace. ALL hook-payload values are untrusted — the
// workspace root comes from process.cwd() (the trusted hook working dir), never the payload,
// and the session id is sanitized to a safe slug before it touches a path or YAML.
import { existsSync, mkdirSync, writeFileSync, readSync, realpathSync, lstatSync, opendirSync } from "fs";
import { join, dirname, sep } from "path";
import { execFileSync } from "child_process";
// ADR-0003: an EXTERNAL workspace (private canon under ~/bureaus) is resolved from a USER-LOCAL
// mapping keyed by the repo's path-free .bureau-id. Builtin-only module — safe for this standalone
// hook (no node_modules). No .bureau-id ⇒ resolveWorkspace returns {mode:"in-repo"} and the legacy
// in-tree scan below runs, so default behavior is unchanged.
import { resolveWorkspace } from "../press/src/core/workspace-map.mjs";

const LOG_DRAWER = "logbook";

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

// the realpath of `target`'s deepest EXISTING ancestor must sit inside `root` (symlink-safe).
function containedUnder(target, root) {
  const rr = safe(() => realpathSync(root), null);
  let a = target; while (!existsSync(a) && a !== dirname(a)) a = dirname(a);
  const ar = safe(() => realpathSync(a), null);
  return !!rr && !!ar && (ar === rr || ar.startsWith(rr + sep));
}

// Find the bureau workspace dir by its bureau.json marker — null if absent/ambiguous → caller
// no-ops. ANY workspace name works (the `canon` default, a legacy `bureau`, a custom name) without
// the hook being told the name. SECURITY: the BUREAU_WORKSPACE override must be a REAL (non-symlink)
// dir contained under cwd (an env symlink can't steer writes outside the repo); the auto-detect scan
// is bounded and skips dotdirs / symlinks. The `bureau.json` MARKER requirement is what keeps it off
// the control/output dirs — `bureau/` (crew), `gazette/`/`board/` (renders) carry no marker — so a
// legacy workspace literally named `bureau` (which DOES carry a marker) still resolves correctly.
function workspaceDir(cwd) {
  const env = process.env.BUREAU_WORKSPACE;
  if (env && /^[A-Za-z0-9._-]+$/.test(env) && env !== "." && env !== "..") {
    const d = join(cwd, env);
    if (safe(() => lstatSync(d).isDirectory(), false) && existsSync(join(d, "bureau.json")) && containedUnder(d, cwd)) return d;
  }
  const dir = safe(() => opendirSync(cwd), null);
  if (!dir) return null;
  const hits = [];
  try { let e, n = 0; while ((e = safe(() => dir.readSync(), null)) && n++ < 4096) {
    if (e.isSymbolicLink() || !e.isDirectory() || e.name.startsWith(".")) continue;
    if (existsSync(join(cwd, e.name, "bureau.json"))) { hits.push(e.name); if (hits.length > 1) break; }
  } } finally { safe(() => dir.closeSync(), null); }
  return hits.length === 1 ? join(cwd, hits[0]) : null;
}

// sanitize an untrusted id to a safe filename/YAML slug (no path separators, no YAML metachars).
// Returns "" when nothing usable remains — the caller no-ops rather than write an "unknown" stub.
function safeId(v) {
  return String(v == null ? "" : v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

// ADR-0003 Phase 4 — DESCRIPTIVE provenance linking a capture to the code repo it ran in (only used
// in EXTERNAL mode, where code and knowledge are separate repos). NOT a reproducibility claim: a bare
// SHA is meaningless on a dirty tree and may become unreachable after a rebase. Best-effort + bounded
// (short timeout), fully safe-wrapped — never blocks session end. Returns null if cwd is not a repo.
function codeProvenance(cwd) {
  // tight per-call deadline so two sequential git calls add ≤2s worst-case to SessionEnd (normally <100ms).
  const git = (args) => safe(() => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }), null);
  const head = (git(["rev-parse", "HEAD"]) || "").trim();
  if (!/^[0-9a-f]{7,64}$/.test(head)) return null; // SHA-1 (40) and SHA-256 (64) object ids
  const status = git(["status", "--porcelain"]);
  return { head, dirty: status == null ? null : (status.trim().length > 0 ? "true" : "false") }; // null ⇒ indeterminate ⇒ omit
}

// read the hook payload (Claude Code passes JSON on stdin). GENUINELY bounded: read in chunks
// and stop the moment we exceed the cap, so a huge/never-closing stdin can't be slurped whole.
function readPayload() {
  // accumulate raw BYTES and decode once: per-chunk toString("utf8") corrupts a multibyte
  // character split across a read boundary, and the cap must count bytes, not UTF-16 units.
  const MAX = 1_000_000;
  const buf = Buffer.alloc(65536);
  const chunks = [];
  let total = 0;
  while (total <= MAX) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); } catch { break; } // EOF/EAGAIN/closed → stop
    if (!n) break; // EOF
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  if (total > MAX) return {}; // oversized → ignore (no-op)
  return safe(() => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), {});
}

function main() {
  const payload = readPayload();
  const cwd = process.cwd(); // TRUSTED working dir, NOT payload.cwd

  // Resolve the workspace. No .bureau-id → the in-tree bureau.json scan (unchanged). A .bureau-id
  // present → the USER-LOCAL mapping (ADR-0003): write to the validated EXTERNAL target. An unpaired
  // or rejected id refuses to write (and says why on stderr) — NEVER silently auto-map, and never
  // fall back to the cwd tree (that would mis-file a private capture into the wrong place).
  const res = safe(() => resolveWorkspace(cwd), { mode: "in-repo" });
  let wsDir = null;
  if (res.mode === "external") wsDir = res.dir;
  else if (res.mode === "in-repo") wsDir = workspaceDir(cwd);
  else if (res.mode === "unpaired") { safe(() => process.stderr.write("bureau capture-stub: .bureau-id '" + res.id + "' is not paired — run: " + res.hint + "\n"), null); return; }
  else { safe(() => process.stderr.write("bureau capture-stub: external workspace refused (" + res.reason + ")\n"), null); return; }
  if (!wsDir) return;

  const sessionId = safeId(payload.session_id || payload.sessionId);
  if (!sessionId) return; // no usable session id (malformed/oversized/empty payload) → no-op
  const transcript = (() => { const t = payload.transcript_path || payload.transcriptPath; return typeof t === "string" ? t.replace(/[\r\n]+/g, " ") : ""; })();

  const now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const short = sessionId.slice(0, 8);

  const dir = join(wsDir, LOG_DRAWER, yyyy, mm);
  const file = join(dir, sessionId + ".md");

  // Containment BEFORE creating anything: the deepest existing ancestor of `dir` must resolve inside
  // the workspace. A symlinked `logbook` (or any ancestor) escaping the workspace → no-op, so we
  // never even create stray directories outside it. Re-check after mkdir (TOCTOU belt-and-suspenders).
  if (!containedUnder(dir, wsDir)) return;
  safe(() => mkdirSync(dir, { recursive: true }), null);
  if (!containedUnder(dir, wsDir)) return;

  const esc = (s) => String(s).replace(/[`\r\n]/g, " "); // keep cwd safe inside markdown backticks
  // full sanitized id (not the 8-char short) so two sessions sharing a prefix can't collide
  // into a duplicate title — gazette rejects duplicate titles.
  const title = "session " + sessionId + " · " + date; // unquoted, sanitized
  // In EXTERNAL mode only, stamp a descriptive code_head/code_dirty link (ADR-0003 Phase 4). In-repo
  // mode keeps the minimal stub — the knowledge is committed WITH the code, so no cross-repo link is
  // needed.
  const prov = res.mode === "external" ? codeProvenance(cwd) : null;
  const fm = ["---", "title: " + title, "updated: " + date, "status: logbook", "session: " + sessionId, "transcript: " + JSON.stringify(transcript)];
  if (prov) { fm.push("code_head: " + prov.head); if (prov.dirty !== null) fm.push("code_dirty: " + prov.dirty); } // omit code_dirty when indeterminate (keep it a boolean)
  fm.push("---");
  const body = [
    ...fm,
    "",
    "## [" + iso + "] session " + short + " — (unfiled)",
    "",
    "Filed under [[Logbook]]. _Mechanical stub written at SessionEnd — run `bureau:file-session` during a session for the full entry (intent, decisions, open threads)._",
    "",
    "- cwd: `" + esc(cwd) + "`",
    "",
  ].join("\n");

  // exclusive create: if a stub or a richer entry already exists, leave it untouched.
  try { writeFileSync(file, body, { flag: "wx" }); }
  catch (e) { if (!(e && e.code === "EEXIST")) safe(() => process.stderr.write("bureau capture-stub: could not write logbook entry (" + (e && e.code || "error") + ")\n"), null); }
}

try { main(); } catch { /* never break session end */ }
process.exit(0);
