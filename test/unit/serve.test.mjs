// L1 — the chamber server (scripts/serve.mjs). Starts a real localhost server on an ephemeral
// port against a temp workspace fixture and drives it over HTTP. Proves the propose/dispose
// invariant (intake writes ONLY a status: logbook minute), input validation, path containment,
// and read-only static serving.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start } from "../../scripts/serve.mjs";

let cwd, srv, base;

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "bureau-serve-"));
  mkdirSync(join(cwd, "canon"), { recursive: true });
  writeFileSync(join(cwd, "canon", "bureau.json"), JSON.stringify({ workspace: "canon", board: "gazette" }));
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
