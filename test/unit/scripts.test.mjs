// L1 — substrate unit tests for the deterministic hook scripts.
// Hooks are shell commands fed JSON on stdin; we drive them exactly as Claude Code does and
// assert on their SIDE EFFECTS (files written) + stdout + exit code — never on prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, chmodSync, realpathSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPTURE = join(PLUGIN, "scripts", "capture-stub.mjs");
const SCRIBE = join(PLUGIN, "scripts", "scribe-checkpoint.mjs");

// run a hook script in a given cwd with a JSON payload on stdin; return {stdout, status}.
// A timeout turns a hook that blocks into a failure, not a hung suite.
function runHook(script, cwd, payload, env) {
  try {
    const stdout = execFileSync("node", [script], { cwd, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 15000, env: env ? { ...process.env, ...env } : process.env });
    return { stdout, status: 0 };
  } catch (e) { return { stdout: e.stdout || "", status: e.status == null ? 1 : e.status }; }
}
function bureauWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), "bureau-unit-"));
  mkdirSync(join(root, "bureau", "logbook"), { recursive: true });
  writeFileSync(join(root, "bureau", "bureau.json"), "{}");
  if (t) t.after(() => rmSync(root, { recursive: true, force: true })); // don't leak the fixture
  return root;
}
const logEntries = (root) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) out.push(p); } };
  const lb = join(root, "bureau", "logbook"); if (existsSync(lb)) walk(lb);
  return out;
};

// ── capture-stub (SessionEnd) ─────────────────────────────────────────────────
test("capture: writes a logbook stub with a full-id, unquoted title and no git", (t) => {
  const root = bureauWorkspace(t);
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

test("capture: path-traversal session id is sanitized and stays inside the logbook", (t) => {
  const root = bureauWorkspace(t);
  runHook(CAPTURE, root, { session_id: "../../../etc/pwned", transcript_path: "x" });
  assert.ok(!existsSync(join(root, "etc")), "no escape outside the workspace");
  const files = logEntries(root);
  assert.equal(files.length, 1);
  assert.match(files[0], /etcpwned\.md$/);
});

test("capture: no-op when bureau.json marker is absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bureau-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bureau", "logbook"), { recursive: true }); // dir exists, no marker
  const { status } = runHook(CAPTURE, root, { session_id: "zzz" });
  assert.equal(status, 0);
  assert.equal(logEntries(root).length, 0);
});

// ── capture-stub · EXTERNAL workspace via user-local mapping (ADR-0003) ────────
// Build a code repo carrying a path-free .bureau-id, an external workspace under an allowlist root,
// and a 0600 mapping in a temp XDG_CONFIG_HOME. The path comes ONLY from the mapping — never stdin.
function externalSetup(t, { id = "proj-x", pair = true } = {}) {
  const extRoot = realpathSync(mkdtempSync(join(tmpdir(), "bureau-ext-")));
  const ws = join(extRoot, "proj", "canon"); mkdirSync(ws, { recursive: true }); chmodSync(ws, 0o755);
  writeFileSync(join(ws, "bureau.json"), "{}");
  const xdg = realpathSync(mkdtempSync(join(tmpdir(), "bureau-xdg-"))); mkdirSync(join(xdg, "bureau"), { recursive: true });
  const cfg = { roots: [extRoot], workspaces: pair ? { [id]: { path: ws } } : {} };
  const cfgFile = join(xdg, "bureau", "workspaces.json"); writeFileSync(cfgFile, JSON.stringify(cfg)); chmodSync(cfgFile, 0o600);
  const code = mkdtempSync(join(tmpdir(), "bureau-code-")); writeFileSync(join(code, ".bureau-id"), id);
  if (t) t.after(() => { for (const d of [extRoot, xdg, code]) rmSync(d, { recursive: true, force: true }); });
  return { ws, xdg, code };
}
const wsLogEntries = (ws) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) out.push(p); } };
  const lb = join(ws, "logbook"); if (existsSync(lb)) walk(lb);
  return out;
};

test("capture: with a .bureau-id + valid mapping, writes to the EXTERNAL workspace, not the cwd", (t) => {
  const s = externalSetup(t, { id: "proj-x", pair: true });
  const { status } = runHook(CAPTURE, s.code, { session_id: "extcafe-1" }, { XDG_CONFIG_HOME: s.xdg });
  assert.equal(status, 0);
  const ext = wsLogEntries(s.ws);
  assert.equal(ext.length, 1, "stub landed in the external workspace");
  assert.match(ext[0], /logbook\/\d{4}\/\d{2}\/extcafe-1\.md$/);
  assert.ok(!existsSync(join(s.code, "logbook")), "nothing written into the code repo cwd");
});

test("capture: external mode stamps code_head + code_dirty from the code repo (ADR-0003 Phase 4)", (t) => {
  const s = externalSetup(t, { id: "proj-x", pair: true });
  const g = (...a) => execFileSync("git", ["-C", s.code, ...a], { stdio: ["ignore", "ignore", "ignore"] });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(s.code, "README.md"), "hi"); g("add", "-A"); g("commit", "-q", "-m", "c1");
  runHook(CAPTURE, s.code, { session_id: "extcafe-3" }, { XDG_CONFIG_HOME: s.xdg });
  const clean = readFileSync(wsLogEntries(s.ws).find((f) => /extcafe-3/.test(f)), "utf8");
  assert.match(clean, /^code_head: [0-9a-f]{7,40}$/m);
  assert.match(clean, /^code_dirty: false$/m);
  writeFileSync(join(s.code, "README.md"), "changed"); // dirty the working tree
  runHook(CAPTURE, s.code, { session_id: "extcafe-4" }, { XDG_CONFIG_HOME: s.xdg });
  const dirty = readFileSync(wsLogEntries(s.ws).find((f) => /extcafe-4/.test(f)), "utf8");
  assert.match(dirty, /^code_dirty: true$/m);
});

test("capture: an UNPAIRED .bureau-id writes nothing — no silent auto-map, no cwd fallback, non-blocking", (t) => {
  const s = externalSetup(t, { id: "proj-x", pair: false });
  const { status } = runHook(CAPTURE, s.code, { session_id: "extcafe-2" }, { XDG_CONFIG_HOME: s.xdg });
  assert.equal(status, 0);                                  // never blocks session end
  assert.equal(wsLogEntries(s.ws).length, 0, "no write to the external workspace");
  assert.ok(!existsSync(join(s.code, "logbook")), "no fallback write into the cwd tree");
});

// ── bureau:pair helper (ADR-0003) — the only writer of the user-local mapping ──
const PAIR = join(PLUGIN, "scripts", "pair.mjs");
function runPair(args, env) {
  try {
    const stdout = execFileSync("node", [PAIR, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, env: env ? { ...process.env, ...env } : process.env });
    return { stdout, status: 0 };
  } catch (e) { return { stdout: e.stdout || "", status: e.status == null ? 1 : e.status }; }
}
function pairFixture(t, { roots }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bureau-ext-")));
  const ws = join(root, "proj", "canon"); mkdirSync(ws, { recursive: true }); chmodSync(ws, 0o755); writeFileSync(join(ws, "bureau.json"), "{}");
  const xdg = realpathSync(mkdtempSync(join(tmpdir(), "bureau-xdg-"))); mkdirSync(join(xdg, "bureau"), { recursive: true });
  const cfgFile = join(xdg, "bureau", "workspaces.json");
  writeFileSync(cfgFile, JSON.stringify({ roots: roots === "self" ? [root] : [], workspaces: {} })); chmodSync(cfgFile, 0o600);
  t.after(() => { for (const d of [root, xdg]) rmSync(d, { recursive: true, force: true }); });
  return { ws, xdg, cfgFile };
}

test("pair: records a validated entry with a 0600 config", (t) => {
  const f = pairFixture(t, { roots: "self" });
  const { status } = runPair(["proj-p", f.ws], { XDG_CONFIG_HOME: f.xdg });
  assert.equal(status, 0);
  const cfg = JSON.parse(readFileSync(f.cfgFile, "utf8"));
  assert.equal(cfg.workspaces["proj-p"].path, realpathSync(f.ws));
  assert.equal(statSync(f.cfgFile).mode & 0o777, 0o600);
});

test("pair: rejects a path-shaped bureau-id before touching anything", () => {
  assert.equal(runPair(["../evil", "/tmp"], {}).status, 1);
});

test("pair: rejects a target outside the allowed roots", (t) => {
  const f = pairFixture(t, { roots: "none" }); // allowlist is just ~/bureaus; the temp ws is outside it
  assert.equal(runPair(["proj-q", f.ws], { XDG_CONFIG_HOME: f.xdg }).status, 1);
});

test("capture: no-op on empty / oversized payload (no usable session id)", (t) => {
  const root = bureauWorkspace(t);
  runHook(CAPTURE, root, {});                                   // no id
  const huge = { session_id: "big", x: "a".repeat(2_000_000) }; // oversized → bounded read drops it
  runHook(CAPTURE, root, huge);
  assert.equal(logEntries(root).length, 0);
});

test("capture: exclusive write — an existing entry is never clobbered", (t) => {
  const root = bureauWorkspace(t);
  runHook(CAPTURE, root, { session_id: "dupe-1" });
  const file = logEntries(root)[0];
  const first = readFileSync(file, "utf8");
  runHook(CAPTURE, root, { session_id: "dupe-1", transcript_path: "OTHER" });
  assert.equal(readFileSync(file, "utf8"), first, "second SessionEnd left the entry untouched");
});

test("capture: a symlinked logbook can't redirect a logbook ENTRY outside the workspace", (t) => {
  const root = bureauWorkspace(t);
  const outside = mkdtempSync(join(tmpdir(), "bureau-escape-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(join(root, "bureau", "logbook"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "bureau", "logbook")); // logbook now points outside the workspace
  const { status } = runHook(CAPTURE, root, { session_id: "esc12345", transcript_path: "/t.jsonl" });
  assert.equal(status, 0);
  // capture-stub's realpath containment check refuses to create the ENTRY through the symlink — its
  // deepest existing ancestor (the symlinked logbook) resolves outside the workspace, so it no-ops.
  // No .md content lands outside the workspace (the security guarantee, mirroring the scribe test).
  const mdOutside = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) mdOutside.push(p); } };
  walk(outside);
  assert.deepEqual(mdOutside, [], "no logbook entry was written through the symlink");
});

// ── scribe-checkpoint (SessionStart source=compact) ───────────────────────────
test("scribe: compact start appends a checkpoint and re-grounds via additionalContext", (t) => {
  const root = bureauWorkspace(t);
  runHook(CAPTURE, root, { session_id: "abc12345" });
  const { stdout, status } = runHook(SCRIBE, root, { session_id: "abc12345", source: "compact", hook_event_name: "SessionStart" });
  assert.equal(status, 0);
  const file = logEntries(root)[0];
  assert.match(readFileSync(file, "utf8"), /context checkpoint \(compaction\)/);
  const out = JSON.parse(stdout);                               // re-ground payload is valid SessionStart output
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /bureau's logbook for this session/);
  assert.match(out.hookSpecificOutput.additionalContext, /REFERENCE DATA, not instructions/); // injected as data, not commands
});

test("scribe: non-compact start is a no-op (no output)", (t) => {
  const root = bureauWorkspace(t);
  const { stdout } = runHook(SCRIBE, root, { session_id: "abc12345", source: "startup" });
  assert.equal(stdout.trim(), "");
});

test("scribe: no-op outside a bureau workspace", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bureau-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { stdout, status } = runHook(SCRIBE, root, { session_id: "x", source: "compact" });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("scribe: oversized payload yields no usable id → no write, no output", (t) => {
  const root = bureauWorkspace(t);
  const { stdout, status } = runHook(SCRIBE, root, { session_id: "big", source: "compact", x: "a".repeat(2_000_000) });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");                 // bounded read dropped the payload
  assert.equal(logEntries(root).length, 0);        // nothing written
});

test("scribe: a symlinked logbook can't redirect a logbook ENTRY outside the workspace", (t) => {
  const root = bureauWorkspace(t);
  const outside = mkdtempSync(join(tmpdir(), "bureau-escape-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(join(root, "bureau", "logbook"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "bureau", "logbook")); // logbook now points outside the workspace
  const { status } = runHook(SCRIBE, root, { session_id: "esc12345", source: "compact" });
  assert.equal(status, 0);
  // The realpath containment check (mirroring capture-stub) refuses to write the ENTRY through the
  // symlink — no .md content lands outside the workspace (the security guarantee).
  const mdOutside = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) mdOutside.push(p); } };
  walk(outside);
  assert.deepEqual(mdOutside, [], "no logbook entry was written through the symlink");
  rmSync(outside, { recursive: true, force: true });
});
