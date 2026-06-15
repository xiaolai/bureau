// L1 — the chamber server (scripts/serve.mjs). Starts a real localhost server on an ephemeral
// port against a temp workspace fixture and drives it over HTTP. Proves the propose/dispose
// invariant (intake writes ONLY a status: logbook minute), input validation, path containment,
// and read-only static serving.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, makeWatcher } from "../../scripts/serve.mjs";

let cwd, srv, base;

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "bureau-serve-"));
  mkdirSync(join(cwd, "canon"), { recursive: true });
  writeFileSync(join(cwd, "canon", "bureau.json"), JSON.stringify({ workspace: "canon", board: "gazette" }));
  // dossier fixtures for the review (dispose) tests
  mkdirSync(join(cwd, "canon", "decisions"), { recursive: true });
  writeFileSync(join(cwd, "canon", "decisions", "0001-adopt.md"), "---\ntitle: ADR 1\nstatus: canonical\n---\n\nbody\n");
  writeFileSync(join(cwd, "canon", "decisions", "0002-ttl.md"), "---\ntitle: Token TTL\nstatus: proposed\nsources: []\n---\n\nTokens last 24h.\n");
  writeFileSync(join(cwd, "canon", "00-overview.md"), "---\ntitle: Overview\n---\n\noverview\n");
  // a built gazette to serve statically
  mkdirSync(join(cwd, "gazette"), { recursive: true });
  writeFileSync(join(cwd, "gazette", "index.html"), "<!DOCTYPE html><title>gz</title><body>GAZETTE</body>");
  srv = await start({ cwd, port: 0 });
  base = "http://" + srv.host + ":" + srv.port;
});
after(() => { if (srv) srv.server.close(); if (cwd) rmSync(cwd, { recursive: true, force: true }); });

const logbook = () => join(cwd, "canon", "logbook");
function minuteFiles() {
  const out = [];
  const walk = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } };
  walk(logbook());
  return out;
}

test("serve: binds localhost only", () => {
  assert.equal(srv.host, "127.0.0.1", "must not bind beyond loopback");
});

test("serve: /health reports the workspace (feature detection)", async () => {
  const r = await fetch(base + "/health");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.workspace, "canon");
});

test("serve: the chamber page renders and names the gate", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Chamber/);
  assert.match(html, /not canon/i, "page states intake is not canon");
});

test("serve: a valid intake writes an append-only status:logbook minute — nothing higher", async () => {
  const before = minuteFiles().length;
  const r = await fetch(base + "/intake", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "Auth tokens last 24h", body: "Confirmed in session x.", author: "ai", drawer: "decisions" }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.status, "logbook");
  const files = minuteFiles();
  assert.equal(files.length, before + 1, "exactly one minute written");
  const text = readFileSync(join(cwd, "canon", j.path), "utf8");
  assert.match(text, /^status: logbook$/m, "minute is low-authority");
  assert.doesNotMatch(text, /status:\s*(verified|canonical)/, "server can NEVER write a higher tier");
  assert.match(text, /author: ai/, "author recorded");
  assert.match(text, /Auth tokens last 24h/, "subject recorded");
});

test("serve: intake without a subject is rejected", async () => {
  const r = await fetch(base + "/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "no subject" }) });
  assert.equal(r.status, 400);
});

test("serve: a path-bearing drawer is sanitized to a safe slug (no traversal)", async () => {
  const r = await fetch(base + "/intake", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "x", body: "y", drawer: "../../etc/passwd" }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  const text = readFileSync(join(cwd, "canon", j.path), "utf8");
  assert.doesNotMatch(text, /\.\.\//, "drawer slug carries no path separators");
  // every minute lives strictly inside the workspace logbook
  for (const f of minuteFiles()) assert.ok(f.startsWith(logbook()), "minute contained in logbook: " + f);
});

test("serve: gazette static files serve read-only; traversal is blocked", async () => {
  const ok = await fetch(base + "/gazette/index.html");
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /GAZETTE/);
  const esc = await fetch(base + "/gazette/..%2f..%2fcanon%2fbureau.json");
  assert.ok(esc.status === 403 || esc.status === 404, "path traversal out of the out dir is blocked (got " + esc.status + ")");
});

test("serve: unknown routes 404; writes only happen via POST /intake", async () => {
  assert.equal((await fetch(base + "/canon/00-overview.md")).status, 404);
  assert.equal((await fetch(base + "/intake")).status, 404, "GET /intake is not a write path");
});

// ── Phase 2: review / dispose (token-gated) ───────────────────────────────────
test("serve: GET /review lists only pending dossiers (proposed/verified/stale)", async () => {
  const j = await (await fetch(base + "/review")).json();
  const paths = j.pending.map((d) => d.path);
  assert.ok(paths.includes("decisions/0002-ttl.md"), "proposed dossier is queued");
  assert.ok(!paths.includes("decisions/0001-adopt.md"), "canonical is not queued");
  assert.ok(!paths.includes("00-overview.md"), "status-less overview is not queued");
});

test("serve: a decision WITHOUT the reviewer token is refused (human disposes)", async () => {
  const r = await fetch(base + "/review/decision", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "decisions/0002-ttl.md", decision: "approve" }),
  });
  assert.equal(r.status, 403, "no token → forbidden");
  assert.match(readFileSync(join(cwd, "canon", "decisions", "0002-ttl.md"), "utf8"), /status: proposed/, "dossier unchanged");
});

test("serve: approve WITH the token promotes to canonical + stamps reviewed", async () => {
  const r = await fetch(base + "/review/decision", {
    method: "POST", headers: { "content-type": "application/json", "x-bureau-review": srv.reviewToken },
    body: JSON.stringify({ path: "decisions/0002-ttl.md", decision: "approve" }),
  });
  assert.equal(r.status, 200);
  const text = readFileSync(join(cwd, "canon", "decisions", "0002-ttl.md"), "utf8");
  assert.match(text, /^status: canonical$/m, "promoted to canonical");
  assert.match(text, /^reviewed: \d{4}-\d{2}-\d{2}$/m, "reviewed date stamped");
  const j = await (await fetch(base + "/review")).json();
  assert.ok(!j.pending.some((d) => d.path === "decisions/0002-ttl.md"), "leaves the queue once canonical");
});

test("serve: reject WITH the token sets contested + appends a review minute", async () => {
  writeFileSync(join(cwd, "canon", "decisions", "0003-retry.md"), "---\ntitle: Retry policy\nstatus: proposed\n---\n\n3 retries.\n");
  const beforeMin = minuteFiles().length;
  const r = await fetch(base + "/review/decision", {
    method: "POST", headers: { "content-type": "application/json", "x-bureau-review": srv.reviewToken },
    body: JSON.stringify({ path: "decisions/0003-retry.md", decision: "reject", reason: "needs a source" }),
  });
  assert.equal(r.status, 200);
  assert.match(readFileSync(join(cwd, "canon", "decisions", "0003-retry.md"), "utf8"), /^status: contested$/m, "sent back to contested");
  assert.equal(minuteFiles().length, beforeMin + 1, "an append-only review minute was written");
});

test("serve: the token can never promote a non-pending or out-of-tree path", async () => {
  const canon = await fetch(base + "/review/decision", {
    method: "POST", headers: { "content-type": "application/json", "x-bureau-review": srv.reviewToken },
    body: JSON.stringify({ path: "decisions/0001-adopt.md", decision: "approve" }),
  });
  assert.equal(canon.status, 404, "an already-canonical dossier is not pending");
  const escape = await fetch(base + "/review/decision", {
    method: "POST", headers: { "content-type": "application/json", "x-bureau-review": srv.reviewToken },
    body: JSON.stringify({ path: "../bureau.json", decision: "approve" }),
  });
  assert.equal(escape.status, 404, "a path outside the pending set is refused");
});

// ── Phase 3: watch / live-rebuild (debounce wiring, timing-independent) ────────
test("serve: makeWatcher debounces a burst of changes into one rebuild", async () => {
  let calls = 0;
  const w = makeWatcher(cwd, () => { calls++; }, { debounceMs: 20 });
  w.fire(); w.fire(); w.fire();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1, "a burst collapses to a single rebuild");
  w.fire();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 2, "a later change triggers another rebuild");
  w.close();
});

// ── audit-fix regressions (v0.5.0 hardening) ──────────────────────────────────
test("serve: refuses to bind a non-loopback host", async () => {
  await assert.rejects(() => start({ cwd, port: 0, host: "0.0.0.0" }), /loopback only/);
});

test("serve: a cross-site Origin is refused on the write endpoints (CSRF)", async () => {
  const intake = await fetch(base + "/intake", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ subject: "x", body: "y" }),
  });
  assert.equal(intake.status, 403, "cross-site intake blocked");
  const decision = await fetch(base + "/review/decision", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "x-bureau-review": srv.reviewToken },
    body: JSON.stringify({ path: "decisions/0002-ttl.md", decision: "approve" }),
  });
  assert.equal(decision.status, 403, "cross-site decision blocked before the token check");
  // a loopback Origin is still accepted
  const ok = await fetch(base + "/intake", {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ subject: "loopback ok", body: "y" }),
  });
  assert.equal(ok.status, 200, "same loopback origin allowed");
});
