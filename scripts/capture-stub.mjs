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
import { existsSync, mkdirSync, writeFileSync, readSync, statSync, realpathSync } from "fs";
import { join, sep } from "path";

const LOG_DRAWER = "logbook";

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

// workspace dir name: a single safe path segment, never absolute or parent-traversing.
function workspaceName() {
  const raw = process.env.BUREAU_WORKSPACE || "bureau";
  return /^[A-Za-z0-9._-]+$/.test(raw) && raw !== "." && raw !== ".." ? raw : "bureau";
}

// sanitize an untrusted id to a safe filename/YAML slug (no path separators, no YAML metachars).
// Returns "" when nothing usable remains — the caller no-ops rather than write an "unknown" stub.
function safeId(v) {
  return String(v == null ? "" : v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

// read the hook payload (Claude Code passes JSON on stdin). GENUINELY bounded: read in chunks
// and stop the moment we exceed the cap, so a huge/never-closing stdin can't be slurped whole.
function readPayload() {
  const MAX = 1_000_000;
  const buf = Buffer.alloc(65536);
  let raw = "";
  while (raw.length <= MAX) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); } catch { break; } // EOF/EAGAIN/closed → stop
    if (!n) break; // EOF
    raw += buf.toString("utf8", 0, n);
  }
  if (raw.length > MAX) return {}; // oversized → ignore (no-op)
  return safe(() => JSON.parse(raw || "{}"), {});
}

function main() {
  const payload = readPayload();
  const cwd = process.cwd(); // TRUSTED working dir, NOT payload.cwd
  const ws = workspaceName();
  const wsDir = join(cwd, ws);

  // act only in a real bureau workspace: a directory carrying the bureau.json marker.
  if (!existsSync(wsDir) || !safe(() => statSync(wsDir).isDirectory(), false)) return;
  if (!existsSync(join(wsDir, "bureau.json"))) return;

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

  // belt-and-suspenders containment: the resolved dir must stay under the workspace.
  safe(() => mkdirSync(dir, { recursive: true }), null);
  const dirReal = safe(() => realpathSync(dir), null);
  const wsReal = safe(() => realpathSync(wsDir), null);
  if (!dirReal || !wsReal || !(dirReal === wsReal || dirReal.startsWith(wsReal + sep))) return;

  const esc = (s) => String(s).replace(/[`\r\n]/g, " "); // keep cwd safe inside markdown backticks
  // full sanitized id (not the 8-char short) so two sessions sharing a prefix can't collide
  // into a duplicate title — whiteboard rejects duplicate titles.
  const title = "session " + sessionId + " · " + date; // unquoted, sanitized
  const body = [
    "---",
    "title: " + title,
    "updated: " + date,
    "status: logbook",
    "session: " + sessionId,
    "transcript: " + JSON.stringify(transcript),
    "---",
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
