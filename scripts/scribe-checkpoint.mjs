#!/usr/bin/env node
// bureau scribe-checkpoint — runs on SessionStart(source="compact"): a compaction just thinned
// the agent's working context. The full conversation is still on disk at transcript_path
// (compaction affects the in-context window, not the transcript file). This hook is MECHANICAL
// (a shell command, no LLM): it (1) marks the compaction boundary in the session's running
// logbook entry, and (2) re-grounds the post-compaction agent by feeding the entry's existing
// notes back via SessionStart additionalContext. The rich summary itself is written by
// `bureau:note` / `bureau:file-session` (LLM, in-session) — this only preserves + re-injects.
//
// VERIFY IN TARGET VERSION (these were not confirmed in the docs checked):
//   - that SessionStart accepts a "compact" matcher (else this fires on every SessionStart;
//     the `source === "compact"` guard below makes that safe — it just no-ops otherwise);
//   - that `hookSpecificOutput.additionalContext` is injected from SessionStart;
//   - if a true PreCompact (pre-signal) exists in your build, prefer it for a high-fidelity
//     headless-`claude -p` summary written BEFORE the context thins.
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, readSync, statSync } from "fs";
import { join } from "path";

const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const workspaceName = () => { const r = process.env.BUREAU_WORKSPACE || "bureau"; return /^[A-Za-z0-9._-]+$/.test(r) && r !== "." && r !== ".." ? r : "bureau"; };
const safeId = (v) => String(v == null ? "" : v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

function readPayload() {
  const MAX = 1_000_000, buf = Buffer.alloc(65536); let raw = "";
  while (raw.length <= MAX) { let n; try { n = readSync(0, buf, 0, buf.length, null); } catch { break; } if (!n) break; raw += buf.toString("utf8", 0, n); }
  return raw.length > MAX ? {} : safe(() => JSON.parse(raw || "{}"), {});
}

function main() {
  const p = readPayload();
  if ((p.source || p.trigger) !== "compact") return; // only act on a post-compaction start
  const cwd = process.cwd(); // TRUSTED working dir, not payload
  const ws = workspaceName(), wsDir = join(cwd, ws);
  if (!existsSync(wsDir) || !safe(() => statSync(wsDir).isDirectory(), false)) return;
  if (!existsSync(join(wsDir, "bureau.json"))) return; // not a bureau workspace → no-op

  const sessionId = safeId(p.session_id || p.sessionId);
  if (!sessionId) return;
  const now = new Date(), iso = now.toISOString();
  const dir = join(wsDir, "logbook", iso.slice(0, 4), iso.slice(5, 7));
  const file = join(dir, sessionId + ".md");

  // 1. mark the compaction boundary in the running entry (create a minimal one if absent).
  safe(() => mkdirSync(dir, { recursive: true }), null);
  const marker = "\n## [" + iso + "] context checkpoint (compaction)\n\n_Context was compacted here. Full transcript on disk. Run `bureau:note` to capture live minutes._\n";
  if (existsSync(file)) safe(() => appendFileSync(file, marker), null);
  else safe(() => writeFileSync(file, "---\ntitle: session " + sessionId + " · " + iso.slice(0, 10) + "\nupdated: " + iso.slice(0, 10) + "\nstatus: logbook\nsession: " + sessionId + "\n---\n" + marker, { flag: "wx" }), null);

  // 2. re-ground the thinned agent: feed the entry's existing notes back into the fresh context.
  const note = safe(() => readFileSync(file, "utf8"), "");
  if (note) {
    const ctx = note.length > 6000 ? note.slice(-6000) : note;
    safe(() => process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "bureau logbook for this session (decisions captured so far — honor it):\n" + ctx },
    })), null);
  }
}

try { main(); } catch { /* never disrupt the session */ }
process.exit(0);
