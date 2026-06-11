// L1 — substrate unit tests for the deterministic hook scripts.
// Hooks are shell commands fed JSON on stdin; we drive them exactly as Claude Code does and
// assert on their SIDE EFFECTS (files written) + stdout + exit code — never on prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPTURE = join(PLUGIN, "scripts", "capture-stub.mjs");
const SCRIBE = join(PLUGIN, "scripts", "scribe-checkpoint.mjs");

// run a hook script in a given cwd with a JSON payload on stdin; return {stdout, status}.
function runHook(script, cwd, payload) {
  try {
    const stdout = execFileSync("node", [script], { cwd, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return { stdout, status: 0 };
  } catch (e) { return { stdout: e.stdout || "", status: e.status == null ? 1 : e.status }; }
}
function bureauWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "bureau-unit-"));
  mkdirSync(join(root, "bureau", "logbook"), { recursive: true });
  writeFileSync(join(root, "bureau", "bureau.json"), "{}");
  return root;
}
const logEntries = (root) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) out.push(p); } };
  const lb = join(root, "bureau", "logbook"); if (existsSync(lb)) walk(lb);
  return out;
};

// ── capture-stub (SessionEnd) ─────────────────────────────────────────────────
test("capture: writes a logbook stub with a full-id, unquoted title and no git", () => {
  const root = bureauWorkspace();
  const { status } = runHook(CAPTURE, root, { session_id: "f00dcafe-1234-5678", transcript_path: "/t.jsonl" });
  assert.equal(status, 0);
  const files = logEntries(root);
  assert.equal(files.length, 1);
  assert.match(files[0], /logbook\/\d{4}\/\d{2}\/f00dcafe-1234-5678\.md$/);
  const body = readFileSync(files[0], "utf8");
  assert.match(body, /^title: session f00dcafe-1234-5678 · \d{4}-\d{2}-\d{2}$/m); // FULL id, unquoted
  assert.match(body, /^status: logbook$/m);
  assert.match(body, /^transcript: "\/t\.jsonl"$/m);                              // JSON-escaped
  assert.ok(!/git/i.test(body), "git was dropped from the stub");
});

test("capture: path-traversal session id is sanitized and stays inside the logbook", () => {
  const root = bureauWorkspace();
  runHook(CAPTURE, root, { session_id: "../../../etc/pwned", transcript_path: "x" });
  assert.ok(!existsSync(join(root, "etc")), "no escape outside the workspace");
  const files = logEntries(root);
  assert.equal(files.length, 1);
  assert.match(files[0], /etcpwned\.md$/);
});

test("capture: no-op when bureau.json marker is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "bureau-unit-"));
  mkdirSync(join(root, "bureau", "logbook"), { recursive: true }); // dir exists, no marker
  const { status } = runHook(CAPTURE, root, { session_id: "zzz" });
  assert.equal(status, 0);
  assert.equal(logEntries(root).length, 0);
});

test("capture: no-op on empty / oversized payload (no usable session id)", () => {
  const root = bureauWorkspace();
  runHook(CAPTURE, root, {});                                   // no id
  const huge = { session_id: "big", x: "a".repeat(2_000_000) }; // oversized → bounded read drops it
  runHook(CAPTURE, root, huge);
  assert.equal(logEntries(root).length, 0);
});

test("capture: exclusive write — an existing entry is never clobbered", () => {
  const root = bureauWorkspace();
  runHook(CAPTURE, root, { session_id: "dupe-1" });
  const file = logEntries(root)[0];
  const first = readFileSync(file, "utf8");
  runHook(CAPTURE, root, { session_id: "dupe-1", transcript_path: "OTHER" });
  assert.equal(readFileSync(file, "utf8"), first, "second SessionEnd left the entry untouched");
});

// ── scribe-checkpoint (SessionStart source=compact) ───────────────────────────
test("scribe: compact start appends a checkpoint and re-grounds via additionalContext", () => {
  const root = bureauWorkspace();
  runHook(CAPTURE, root, { session_id: "abc12345" });
  const { stdout, status } = runHook(SCRIBE, root, { session_id: "abc12345", source: "compact", hook_event_name: "SessionStart" });
  assert.equal(status, 0);
  const file = logEntries(root)[0];
  assert.match(readFileSync(file, "utf8"), /context checkpoint \(compaction\)/);
  const out = JSON.parse(stdout);                               // re-ground payload is valid SessionStart output
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /bureau logbook for this session/);
});

test("scribe: non-compact start is a no-op (no output)", () => {
  const root = bureauWorkspace();
  const { stdout } = runHook(SCRIBE, root, { session_id: "abc12345", source: "startup" });
  assert.equal(stdout.trim(), "");
});

test("scribe: no-op outside a bureau workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "bureau-unit-"));
  const { stdout, status } = runHook(SCRIBE, root, { session_id: "x", source: "compact" });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});
