#!/usr/bin/env node
// bureau serve — the CHAMBER (Phase 1). A localhost-only server that gives the single
// human (and, later, a convened AI desk) an interactive room whose output feeds the gate
// instead of bypassing it. Two jobs:
//   1. serve the built gazette READ-ONLY (static files, path-contained, no listing)
//   2. accept INTAKE: a proposed claim POSTed from the chamber form lands as an
//      append-only `status: logbook` minute — never a dossier, never `verified`/`canonical`.
//
// The propose/dispose invariant is enforced STRUCTURALLY here: this server's only write
// power is appending logbook minutes. Distilling to a dossier is `bureau:compile`; promoting
// to `canonical` is `bureau:review` (a human). No endpoint can forge a higher tier.
//
// Threat model (a write backend is real surface): bind 127.0.0.1 only; cap request bodies;
// allowlist methods+routes; realpath-contain every path (static reads AND minute writes) to
// the workspace/out dir; sanitize the one path-bearing field (`drawer`); exclusive-create so
// a write never clobbers an existing minute. Untrusted input is validated at the boundary.
import http from "node:http";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, realpathSync, lstatSync, opendirSync } from "node:fs";
import { join, dirname, resolve, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_DRAWER = "logbook";
const BODY_CAP = 100_000;        // max POST body bytes
const SUBJECT_CAP = 200;         // max claim subject chars
const BODY_TEXT_CAP = 10_000;    // max claim body chars

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

// ── workspace + containment (same discipline as scripts/capture-stub.mjs) ──────────
// realpath of `target`'s deepest EXISTING ancestor must sit inside `root` (symlink-safe).
function containedUnder(target, root) {
  const rr = safe(() => realpathSync(root), null);
  let a = target; while (!existsSync(a) && a !== dirname(a)) a = dirname(a);
  const ar = safe(() => realpathSync(a), null);
  return !!rr && !!ar && (ar === rr || ar.startsWith(rr + sep));
}

// Find the bureau workspace dir by its bureau.json marker — null if absent/ambiguous.
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

function safeId(v) { return String(v == null ? "" : v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64); }
const oneLine = (s) => String(s).replace(/[`\r\n]+/g, " ");

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function send(res, code, type, body) { res.writeHead(code, { "content-type": type, "x-content-type-options": "nosniff" }); res.end(body); }
function sendJson(res, code, obj) { send(res, code, "application/json; charset=utf-8", JSON.stringify(obj)); }

// read a bounded request body; reject (resolve null) if it exceeds the cap.
function readBody(req) {
  return new Promise((res2) => {
    let raw = "", over = false;
    req.on("data", (c) => { if (over) return; raw += c; if (raw.length > BODY_CAP) { over = true; } });
    req.on("end", () => res2(over ? null : raw));
    req.on("error", () => res2(null));
  });
}

// ── intake: a proposed claim → an append-only logbook minute (low authority) ───────
function writeIntake(ctx, body) {
  let b; try { b = JSON.parse(body || "{}"); } catch { return { code: 400, err: "invalid JSON" }; }
  const subject = String(b.subject == null ? "" : b.subject).trim();
  const text = String(b.body == null ? "" : b.body).trim();
  if (!subject) return { code: 400, err: "subject is required" };
  if (subject.length > SUBJECT_CAP) return { code: 400, err: "subject too long (max " + SUBJECT_CAP + ")" };
  if (text.length > BODY_TEXT_CAP) return { code: 400, err: "body too long (max " + BODY_TEXT_CAP + ")" };
  const author = b.author === "ai" ? "ai" : "human";   // enum — the AI seat is "ai", default human
  const drawer = safeId(b.drawer);                      // optional cabinet hint, path-safe slug only

  const now = new Date(), iso = now.toISOString(), date = iso.slice(0, 10);
  const dir = join(ctx.wsDir, LOG_DRAWER, iso.slice(0, 4), iso.slice(5, 7));
  // containment BEFORE any mkdir so a symlinked logbook can't steer a write outside the workspace
  if (!containedUnder(dir, ctx.wsDir)) return { code: 500, err: "workspace containment check failed" };
  safe(() => mkdirSync(dir, { recursive: true }), null);
  if (!containedUnder(dir, ctx.wsDir)) return { code: 500, err: "workspace containment check failed" };

  const seq = ctx.nextSeq();
  const id = ctx.sessionId + "-" + seq;                 // unique per server run → no title/file collision
  const file = join(dir, id + ".md");
  const fm = [
    "---",
    "title: chamber " + id + " · " + date,               // unique title (gazette rejects dups)
    "updated: " + date,
    "status: logbook",                                   // LOW authority — the gate's floor
    "origin: chamber",
    "author: " + author,
    "session: " + ctx.sessionId,
    drawer ? "drawer: " + drawer : null,
    "---",
    "",
    "## [" + iso + "] " + oneLine(subject),
    "",
    text || "_(no detail provided)_",
    "",
    "Filed under [[Logbook]]. _Proposed in the chamber (" + author + "). Enters `bureau:compile` → " +
      "`bureau:review`; it is **not** canon until a human approves._",
    "",
  ].filter((l) => l !== null).join("\n");

  try { writeFileSync(file, fm, { flag: "wx" }); }      // exclusive create — never clobber a minute
  catch (e) { return { code: 500, err: "could not write minute (" + (e && e.code || "error") + ")" }; }
  return { code: 200, path: join(LOG_DRAWER, iso.slice(0, 4), iso.slice(5, 7), id + ".md") };
}

// ── safe static read from the gazette out dir (read-only, path-contained) ──────────
function serveStatic(res, outDir, rel) {
  if (rel.includes("\0")) return send(res, 400, "text/plain", "bad path");
  let relPath; try { relPath = decodeURIComponent(rel); } catch { return send(res, 400, "text/plain", "bad path"); }
  const target = normalize(join(outDir, relPath));
  // lexical containment, then realpath containment (symlink-safe)
  if (target !== outDir && !target.startsWith(outDir + sep)) return send(res, 403, "text/plain", "forbidden");
  let st = safe(() => statSync(target), null);
  let file = target;
  if (st && st.isDirectory()) { file = join(target, "index.html"); st = safe(() => statSync(file), null); }
  if (!st || !st.isFile() || !containedUnder(file, outDir)) return send(res, 404, "text/plain", "not found");
  const data = safe(() => readFileSync(file), null);
  if (data == null) return send(res, 404, "text/plain", "not found");
  send(res, 200, TYPES[extname(file).toLowerCase()] || "application/octet-stream", data);
}

function chamberPage(ctx) {
  const gz = existsSync(join(ctx.outDir, "index.html"));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chamber · ${esc(ctx.wsName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .sub { color: #888; margin: 0 0 24px; font-size: 13px; }
  label { display: block; font-weight: 600; font-size: 13px; margin: 16px 0 4px; }
  input, textarea, select { width: 100%; padding: 8px 10px; font: inherit; border: 1px solid #bbb; border-radius: 8px; box-sizing: border-box; }
  textarea { min-height: 140px; resize: vertical; }
  .row { display: flex; gap: 12px; } .row > * { flex: 1; }
  button { margin-top: 18px; padding: 9px 18px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: #3a5d6e; color: #fff; cursor: pointer; }
  .note { margin-top: 18px; padding: 10px 12px; border-radius: 8px; font-size: 13px; background: rgba(120,140,120,.12); }
  .ok { background: rgba(80,160,90,.15); } .err { background: rgba(190,80,80,.15); }
  a { color: #3a5d6e; }
</style></head><body>
  <h1>Chamber — ${esc(ctx.wsName)}</h1>
  <p class="sub">Propose a claim. It lands as an append-only logbook minute and enters
    <code>bureau:compile</code> → <code>bureau:review</code>. It is <strong>not canon</strong> until a human approves.
    ${gz ? '· <a href="/gazette/">open the gazette →</a>' : "· <em>gazette not built yet — run bureau:inspect</em>"}</p>
  <form id="f">
    <label for="subject">Claim / decision</label>
    <input id="subject" name="subject" maxlength="${SUBJECT_CAP}" required placeholder="e.g. Auth tokens last 24h">
    <label for="body">Detail &amp; reasoning</label>
    <textarea id="body" name="body" maxlength="${BODY_TEXT_CAP}" placeholder="Why, with any sources…"></textarea>
    <div class="row">
      <div><label for="drawer">Cabinet (optional)</label><input id="drawer" name="drawer" maxlength="64" placeholder="decisions"></div>
      <div><label for="author">Proposed by</label><select id="author" name="author"><option value="human">human</option><option value="ai">ai</option></select></div>
    </div>
    <button type="submit">Propose to the logbook</button>
  </form>
  <div id="out" class="note" hidden></div>
<script>
  var f = document.getElementById("f"), out = document.getElementById("out");
  f.addEventListener("submit", async function (e) {
    e.preventDefault();
    var b = { subject: f.subject.value, body: f.body.value, drawer: f.drawer.value, author: f.author.value };
    out.hidden = false; out.className = "note"; out.textContent = "Filing…";
    try {
      var r = await fetch("/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      var j = await r.json();
      if (r.ok) { out.className = "note ok"; out.textContent = "Filed → " + j.path + " (status: logbook). Run bureau:compile, then bureau:review."; f.reset(); }
      else { out.className = "note err"; out.textContent = "Rejected: " + (j.err || r.status); }
    } catch (err) { out.className = "note err"; out.textContent = "Failed: " + err.message; }
  });
</script></body></html>`;
}

function handle(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, workspace: ctx.wsName });
  if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(res, 200, "text/html; charset=utf-8", chamberPage(ctx));
  if (req.method === "GET" && (path === "/gazette" || path.startsWith("/gazette/"))) {
    return serveStatic(res, ctx.outDir, path.replace(/^\/gazette\/?/, ""));
  }
  if (req.method === "POST" && path === "/intake") {
    return readBody(req).then((body) => {
      if (body == null) return sendJson(res, 413, { err: "request body too large or unreadable" });
      const r = writeIntake(ctx, body);
      if (r.code === 200) return sendJson(res, 200, { ok: true, path: r.path, status: "logbook" });
      return sendJson(res, r.code, { err: r.err });
    });
  }
  return send(res, 404, "text/plain", "not found");
}

// Start the chamber. Resolves the workspace, binds 127.0.0.1, returns the live server.
// `host`/`port` are overridable for tests (port 0 = ephemeral). Never binds beyond localhost.
export async function start({ cwd = process.cwd(), out = "gazette", port = 4317, host = "127.0.0.1" } = {}) {
  const wsDir = workspaceDir(cwd);
  if (!wsDir) throw new Error("no bureau workspace found in " + cwd + " — run bureau:init first");
  const ctx = {
    wsDir, wsName: wsDir.slice(dirname(wsDir).length + 1), outDir: resolve(cwd, out),
    sessionId: "chamber-" + Date.now().toString(36), _seq: 0, nextSeq() { return ++this._seq; },
  };
  const server = http.createServer((req, res) => { try { handle(req, res, ctx); } catch (e) { safe(() => sendJson(res, 500, { err: "internal error" }), null); } });
  await new Promise((res2, rej) => { server.once("error", rej); server.listen(port, host, res2); });
  return { server, wsDir, wsName: ctx.wsName, host, port: server.address().port, sessionId: ctx.sessionId };
}

// internal helpers exported for unit tests (not a public API)
export const _internal = { workspaceDir, containedUnder, safeId, writeIntake };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  start({ out: opt("out", "gazette"), port: parseInt(opt("port", "4317"), 10), host: opt("host", "127.0.0.1") })
    .then(({ host, port, wsName }) => process.stdout.write("bureau chamber → http://" + host + ":" + port + "  (workspace: " + wsName + ")\n  Ctrl-C to stop.\n"))
    .catch((e) => { process.stderr.write("bureau serve: " + e.message + "\n"); process.exit(1); });
}
