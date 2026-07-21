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
// Threat model (a write backend is real surface): bind loopback only; reject cross-site Origins
// (CSRF); cap request bodies by BYTES; allowlist methods+routes; realpath-contain every path
// (static reads AND writes); no-symlink-follow on file reads/writes; atomic temp+rename so a write
// can't truncate; exclusive-create so a write never clobbers. Untrusted input is validated at the
// boundary. Accepted residuals (out of the single-user-localhost model): a parent-DIRECTORY symlink
// swapped mid-request, two concurrent decisions racing one dossier (atomic rename keeps it
// non-corrupting, last-writer-wins), and synchronous small-file reads — all require a local attacker
// who already has workspace write access, which is game-over regardless.
import http from "node:http";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, realpathSync, lstatSync, opendirSync, readdirSync, renameSync, rmSync, openSync, closeSync, constants as FS, watch as fsWatch } from "node:fs";
import { join, dirname, resolve, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";

const LOG_DRAWER = "logbook";
const BODY_CAP = 100_000;        // max POST body bytes
const SUBJECT_CAP = 200;         // max claim subject chars
const BODY_TEXT_CAP = 10_000;    // max claim body chars

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

// no-symlink-follow file primitives — close the symlink-swap TOCTOU on the final path component
// (the residual parent-directory race is out of the single-user-localhost threat model). `writeNew`
// is an exclusive create; `readNoFollow` refuses to read through a symlinked file.
function writeNew(path, data) {
  let fd; try { fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644); } catch { return false; }
  let ok = false;
  try { writeFileSync(fd, data); ok = true; } catch { ok = false; } finally { safe(() => closeSync(fd), null); } // writeFileSync writes ALL bytes (no short-write)
  // A failed write (disk full, I/O error) leaves the just-created exclusive file empty/partial —
  // remove it so a later minute with the same name isn't blocked by O_EXCL and no corrupt file is read.
  if (!ok) safe(() => rmSync(path), null);
  return ok;
}
function readNoFollow(path) {
  let fd; try { fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW); } catch { return null; }
  try { return readFileSync(fd); } catch { return null; } finally { safe(() => closeSync(fd), null); }
}

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
    const chunks = []; let bytes = 0, done = false;
    const settle = (v) => { if (!done) { done = true; res2(v); } };
    req.on("data", (c) => {
      if (done) return;
      bytes += c.length;                                   // BYTES, not string chars (multibyte-safe)
      if (bytes > BODY_CAP) { settle(null); return; }       // stop buffering; let the handler send 413, no socket reset
      chunks.push(c);
    });
    req.on("end", () => settle(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => settle(null));
    req.on("aborted", () => settle(null));                 // client abort → settle once, no pending handler
    req.on("close", () => settle(null));
  });
}

// reject cross-site browser requests (CSRF). Browsers attach Origin on cross-origin writes; the
// chamber page is same (loopback) origin; non-browser clients (curl, the AI seat) send no Origin.
function csrfOK(req) {
  const o = req.headers["origin"];
  if (!o) return true;
  try { return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(new URL(o).hostname); } catch { return false; }
}

// A state-changing POST must be application/json. A cross-origin HTML <form> can only send
// urlencoded/multipart/text-plain (JSON requires a preflighted fetch, which same-origin policy
// blocks without CORS) — so this rejects the form-auto-submit CSRF a bare Origin check can miss,
// including one launched from another loopback port that happens to pass csrfOK.
function jsonPost(req) {
  return /^application\/json\b/i.test(String(req.headers["content-type"] || ""));
}

// Parse a request body as a JSON OBJECT. Returns null for invalid JSON OR any non-object shape
// (JSON `null`, array, number, string, boolean) — callers turn null into a 400 instead of
// dereferencing it. `JSON.parse("null")` succeeds and yields null, so a bare shape check is not
// enough; this is the single choke point that keeps a hostile body from crashing a handler. An
// empty/absent body is intentionally treated as `{}` (an object), so callers reject it through their
// own field checks with a more specific message ("subject is required") rather than "invalid JSON".
function parseJsonObject(body) {
  let b; try { b = JSON.parse(body || "{}"); } catch { return null; }
  return (b && typeof b === "object" && !Array.isArray(b)) ? b : null;
}

// Build (and create) the dated logbook subdir YYYY/MM, with containment checks bracketing the mkdir
// so a symlinked logbook can't steer the write outside the workspace. Returns the dir, or null on a
// containment failure (the caller turns that into its own error). One source of truth for the
// intake and review-minute writers.
function logbookDir(ctx, iso) {
  const dir = join(ctx.wsDir, LOG_DRAWER, iso.slice(0, 4), iso.slice(5, 7));
  if (!containedUnder(dir, ctx.wsDir)) return null;
  safe(() => mkdirSync(dir, { recursive: true }), null);
  if (!containedUnder(dir, ctx.wsDir)) return null;
  return dir;
}

// ── intake: a proposed claim → an append-only logbook minute (low authority) ───────
function writeIntake(ctx, body) {
  const b = parseJsonObject(body);
  if (!b) return { code: 400, err: "invalid JSON — expected an object" };
  const subject = String(b.subject == null ? "" : b.subject).trim();
  const text = String(b.body == null ? "" : b.body).trim();
  if (!subject) return { code: 400, err: "subject is required" };
  if (subject.length > SUBJECT_CAP) return { code: 400, err: "subject too long (max " + SUBJECT_CAP + ")" };
  if (text.length > BODY_TEXT_CAP) return { code: 400, err: "body too long (max " + BODY_TEXT_CAP + ")" };
  const author = b.author === "ai" ? "ai" : "human";   // enum — the AI seat is "ai", default human
  const drawer = safeId(b.drawer);                      // optional cabinet hint, path-safe slug only

  const now = new Date(), iso = now.toISOString(), date = iso.slice(0, 10);
  const dir = logbookDir(ctx, iso);
  if (!dir) return { code: 500, err: "workspace containment check failed" };

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

  if (!writeNew(file, fm)) return { code: 500, err: "could not write minute" }; // exclusive, no-follow create
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
  const data = readNoFollow(file);                          // refuses a file swapped to a symlink after the check
  if (data == null) return send(res, 404, "text/plain", "not found");
  send(res, 200, TYPES[extname(file).toLowerCase()] || "application/octet-stream", data);
}

// ── review / dispose (Phase 2) ─────────────────────────────────────────────────────
// Listing pending dossiers is OPEN (read-only); the DECISION (promotion) is the human's act
// and is gated by a token printed to the terminal at startup — the human has it, the AI's
// agent context does not. propose = open (AI seat); dispose = token-gated (human only).
const REVIEWABLE = new Set(["proposed", "verified", "stale"]);

function leadingFm(s) {
  const m = /^---\n([\s\S]*?)\n---/.exec(s || "");
  if (!m) return null;
  const o = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0 && /^[A-Za-z0-9_-]+$/.test(line.slice(0, i).trim())) o[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return o;
}

// Every cabinet dossier awaiting a human decision. Excludes the logbook (intake, not canon),
// the lint drawer, and `_`/dot entries (types, state, ledgers) — mirrors what the recall skill
// treats as canon. Never trusts a client path; the decision endpoint re-derives this set.
function cabinetDossiers(wsDir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of safe(() => readdirSync(abs, { withFileTypes: true }), [])) {
      if (e.name.startsWith("_") || e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (rel === "" && (e.name === LOG_DRAWER || e.name === "lint")) continue; walk(join(abs, e.name), childRel); }
      else if (e.isFile() && e.name.endsWith(".md")) {
        const fm = leadingFm(safe(() => readFileSync(join(abs, e.name), "utf8"), ""));
        if (fm && REVIEWABLE.has(fm.status)) out.push({ path: childRel, title: fm.title || e.name, status: fm.status });
      }
    }
  };
  walk(wsDir, "");
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

// Rewrite ONLY the leading frontmatter: update keys present, append keys that are new, drop keys
// whose value is null. The body is untouched.
function rewriteFrontmatter(text, changes) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const applied = new Set();
  const lines = m[1].split("\n").map((line) => {
    const i = line.indexOf(":"); const key = i > 0 ? line.slice(0, i).trim() : null;
    if (key && key in changes) { applied.add(key); return changes[key] == null ? null : key + ": " + changes[key]; }
    return line;
  }).filter((l) => l !== null);
  for (const [k, v] of Object.entries(changes)) if (!applied.has(k) && v != null) lines.push(k + ": " + v);
  return "---\n" + lines.join("\n") + "\n---" + text.slice(m[0].length);
}

// The human's dispose action. approve → canonical + reviewed date; reject → contested + an
// append-only review minute naming what was rejected (the audit trail; never a destructive delete
// in a browser — a contested page is re-decided in a session). Token already checked by the route.
function applyDecision(ctx, body) {
  const b = parseJsonObject(body);
  if (!b) return { code: 400, err: "invalid JSON — expected an object" };
  const decision = b.decision === "approve" ? "approve" : b.decision === "reject" ? "reject" : null;
  if (!decision) return { code: 400, err: "decision must be 'approve' or 'reject'" };
  const rel = String(b.path == null ? "" : b.path);
  const match = cabinetDossiers(ctx.wsDir).find((d) => d.path === rel);   // re-derive — never trust the client path
  if (!match) return { code: 404, err: "not a pending dossier" };
  const abs = join(ctx.wsDir, rel);
  if (!containedUnder(abs, ctx.wsDir)) return { code: 500, err: "containment check failed" };
  const text = safe(() => readFileSync(abs, "utf8"), null);
  if (text == null) return { code: 404, err: "dossier unreadable" };
  const date = new Date().toISOString().slice(0, 10);
  const changes = decision === "approve" ? { status: "canonical", updated: date, reviewed: date } : { status: "contested", updated: date };
  const next = rewriteFrontmatter(text, changes);
  if (next == null) return { code: 500, err: "dossier has no frontmatter" };
  if (safe(() => lstatSync(abs).isSymbolicLink(), false)) return { code: 500, err: "refusing to write through a symlink" };
  // reject: write the audit minute FIRST — never flip a dossier without the promised audit trail
  if (decision === "reject" && !appendReviewMinute(ctx, match, String(b.reason == null ? "" : b.reason)))
    return { code: 500, err: "could not write the review minute — dossier left unchanged" };
  // atomic write: exclusive no-follow temp in the same (contained) dir → rename (a crash can't truncate)
  const tmp = abs + ".bureau-tmp-" + ctx.nextSeq();
  if (!writeNew(tmp, next)) return { code: 500, err: "could not write dossier" };
  if (safe(() => renameSync(tmp, abs), "fail") === "fail") { safe(() => rmSync(tmp), null); return { code: 500, err: "could not finalize dossier" }; }
  return { code: 200, path: rel, status: changes.status };
}

// append-only record of a rejection (mirrors the CLI review's "append a review minute").
// Returns true only if the minute was durably written — the caller refuses to flip the dossier
// without it, so the audit trail can't silently vanish.
function appendReviewMinute(ctx, match, reason) {
  const iso = new Date().toISOString(), date = iso.slice(0, 10);
  const dir = logbookDir(ctx, iso);
  if (!dir) return false;
  const id = ctx.sessionId + "-review-" + ctx.nextSeq();
  const fm = [
    "---", "title: chamber review " + id + " · " + date, "updated: " + date, "status: logbook",
    "origin: chamber-review", "session: " + ctx.sessionId, "---", "",
    "## [" + iso + "] rejected — " + oneLine(match.title),
    "", "Rejected `" + oneLine(match.path) + "` (was " + match.status + ") → `contested`.",
    reason ? "\nReason: " + oneLine(reason) : "",
    "", "_Re-decide in a session; the gate is preserved._", "",
  ].join("\n");
  return writeNew(join(dir, id + ".md"), fm);
}

// The chamber page is static except for the workspace name and the gazette link. Its stylesheet and
// client script carry NO server data, so they live as module constants — chamberPage() weaves in only
// the few dynamic bits, keeping markup, style, and behavior separately readable. (Neither constant
// contains a backtick or ${…}, so they are safe as plain template literals.)
const CHAMBER_CSS = `
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
  hr { margin: 34px 0; border: 0; border-top: 1px solid #ddd; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  #token { max-width: 340px; }
  .prow { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #eee; }
  .tier { color: #888; font-size: 12px; }
  .acts { display: flex; gap: 8px; flex: none; }
  button.mini { margin: 0; padding: 5px 12px; font-size: 13px; }
  button.ghost { background: transparent; color: #a33; border: 1px solid #d99; }
`;

const CHAMBER_SCRIPT = `
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

  var tokenEl = document.getElementById("token"); // kept in the field for the page lifetime only — never persisted to Web Storage
  var pending = document.getElementById("pending"), rout = document.getElementById("rout"), rcount = document.getElementById("rcount");
  async function loadReview() {
    try {
      var j = await (await fetch("/review")).json();
      rcount.textContent = "(" + j.pending.length + ")";
      pending.textContent = "";
      if (!j.pending.length) { var e = document.createElement("p"); e.className = "sub"; e.textContent = "Nothing awaiting review."; pending.appendChild(e); return; }
      j.pending.forEach(function (d) {
        var row = document.createElement("div"); row.className = "prow";
        var meta = document.createElement("div");
        var t = document.createElement("strong"); t.textContent = d.title;             // textContent = no injection
        var s = document.createElement("span"); s.className = "tier"; s.textContent = " " + d.status + " · " + d.path;
        meta.appendChild(t); meta.appendChild(s);
        var ok = document.createElement("button"); ok.textContent = "Approve"; ok.className = "mini";
        var no = document.createElement("button"); no.textContent = "Reject"; no.className = "mini ghost";
        ok.onclick = function () { decide(d.path, "approve"); };
        no.onclick = function () { decide(d.path, "reject", prompt("Reason for rejecting (optional):") || ""); };
        var acts = document.createElement("div"); acts.className = "acts"; acts.appendChild(ok); acts.appendChild(no);
        row.appendChild(meta); row.appendChild(acts); pending.appendChild(row);
      });
    } catch (err) {                                          // a failed load must surface, not hang as an unhandled rejection with stale UI
      rcount.textContent = ""; pending.textContent = "";
      var pe = document.createElement("p"); pe.className = "sub err"; pe.textContent = "Could not load pending review: " + err.message; pending.appendChild(pe);
    }
  }
  async function decide(path, decision, reason) {
    rout.hidden = false; rout.className = "note"; rout.textContent = "Deciding…";
    try {
      var r = await fetch("/review/decision", { method: "POST", headers: { "content-type": "application/json", "x-bureau-review": tokenEl.value }, body: JSON.stringify({ path: path, decision: decision, reason: reason }) });
      var j = await r.json();
      if (r.ok) { rout.className = "note ok"; rout.textContent = (decision === "approve" ? "Promoted → canonical: " : "Sent back → contested: ") + j.path; loadReview(); }
      else { rout.className = "note err"; rout.textContent = "Rejected: " + (j.err || r.status); }
    } catch (err) { rout.className = "note err"; rout.textContent = "Failed: " + err.message; }
  }
  loadReview();
`;

function chamberPage(ctx) {
  const gz = existsSync(join(ctx.outDir, "index.html"));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chamber · ${esc(ctx.wsName)}</title>
<style>${CHAMBER_CSS}</style></head><body>
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

  <hr>
  <h2>Pending review <span id="rcount" class="tier"></span></h2>
  <p class="sub">Promote vetted claims to <strong>canonical</strong>, or send them back to <strong>contested</strong>.
    Disposing is the human's act — paste the reviewer token printed in your <code>bureau:serve</code> terminal.</p>
  <input id="token" type="password" placeholder="reviewer token" autocomplete="off">
  <div id="pending" style="margin-top:14px"></div>
  <div id="rout" class="note" hidden></div>
<script>${CHAMBER_SCRIPT}</script></body></html>`;
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
    if (!csrfOK(req) || !jsonPost(req)) return sendJson(res, 403, { err: "cross-site request refused" });
    return readBody(req).then((body) => {
      if (body == null) return sendJson(res, 413, { err: "request body too large or unreadable" });
      const r = writeIntake(ctx, body);
      if (r.code === 200) return sendJson(res, 200, { ok: true, path: r.path, status: "logbook" });
      return sendJson(res, r.code, { err: r.err });
    });
  }
  // dispose — listing is open (read-only); deciding is the human's act, token-gated.
  if (req.method === "GET" && path === "/review") return sendJson(res, 200, { pending: cabinetDossiers(ctx.wsDir) });
  if (req.method === "POST" && path === "/review/decision") {
    if (!csrfOK(req) || !jsonPost(req)) return sendJson(res, 403, { err: "cross-site request refused" });
    if (req.headers["x-bureau-review"] !== ctx.reviewToken) return sendJson(res, 403, { err: "reviewer token required — see the bureau:serve terminal output" });
    return readBody(req).then((body) => {
      if (body == null) return sendJson(res, 413, { err: "request body too large or unreadable" });
      const r = applyDecision(ctx, body);
      if (r.code === 200) return sendJson(res, 200, { ok: true, path: r.path, status: r.status });
      return sendJson(res, r.code, { err: r.err });
    });
  }
  return send(res, 404, "text/plain", "not found");
}

// ── watch / live-rebuild (Phase 3) ───────────────────────────────────────────────
// Watch the workspace and rebuild the gazette on change, debounced. The static handler reads
// from disk per request, so a rebuilt out dir is served live (the browser refreshes to see it).
// Exported so the debounce/build wiring is unit-testable without depending on fs.watch timing.
export function makeWatcher(dir, build, { debounceMs = 250 } = {}) {
  let timer = null, pending = false, watcher = null, closed = false;
  const fire = () => {
    if (closed) return;                                    // a change arriving after close() is ignored
    pending = true; if (timer) return;
    timer = setTimeout(() => { timer = null; if (pending && !closed) { pending = false; Promise.resolve().then(build).catch((e) => safe(() => process.stderr.write("bureau serve: rebuild error — " + (e && e.message || e) + "\n"), null)); } }, debounceMs);
  };
  try { watcher = fsWatch(dir, { recursive: true }, fire); }
  catch (e) { watcher = null; } // recursive watch unsupported (older Node on Linux) → caller warns
  // close() must cancel any queued debounce so a rebuild can't start after the chamber is gone.
  const close = () => { closed = true; if (timer) { clearTimeout(timer); timer = null; } pending = false; safe(() => watcher && watcher.close(), null); };
  return { fire, supported: !!watcher, close };
}

// spawn the bundled press to rebuild the gazette out dir from the workspace.
function rebuildGazette(ctx) {
  const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), "press", "bin", "gazette.mjs");
  return new Promise((res2) => {
    const ch = spawn(process.execPath, [bin, "build", "--dir", ctx.wsDir, "--out", ctx.outDir], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; ch.stderr.on("data", (d) => { err += d; });
    ch.on("close", (code) => { if (code !== 0) safe(() => process.stderr.write("bureau serve: rebuild failed (" + err.slice(0, 160).replace(/\n/g, " ") + ")\n"), null); res2(code === 0); });
    ch.on("error", (e) => { safe(() => process.stderr.write("bureau serve: could not spawn the renderer — " + (e && e.message || e) + "\n"), null); res2(false); });
  });
}

// ── port policy ────────────────────────────────────────────────────────────────────
// A repo's chamber must not fight another repo's chamber over one well-known port — bureau is
// meant to run per-repo, several at once. So when the caller pins no port we pick a RANDOM 5-digit
// loopback port and re-roll on the (astronomically unlikely) collision until one is free. A pinned
// port (`--port <n>`, or `port: 0` = OS-ephemeral used by tests) is honored STRICTLY: a collision
// throws so the user hears about it, rather than silently wandering onto a port they didn't ask for.
const PORT_MIN = 10000, PORT_MAX = 65535;                 // the 5-digit loopback range
const randomPort = () => randomInt(PORT_MIN, PORT_MAX + 1); // uniform in [PORT_MIN, PORT_MAX]

// Bind `server` to `host`. `port == null` → auto-pick a random 5-digit port, re-rolling on
// EADDRINUSE up to `tries` times. A concrete `port` is bound as-is (a collision propagates). The
// same http.Server is reused across attempts — a failed listen leaves it non-listening, so the next
// listen() re-binds cleanly; both one-shot listeners are removed each attempt so none accumulate.
async function listenChamber(server, host, port, tries = 40, pick = randomPort) {
  // Zero-trust the port: `null` means auto-pick; anything else must be a real TCP port integer.
  // Without this a stray string would reach server.listen() and be read as an IPC socket path, and a
  // NaN/boolean would bind nonsense — the CLI validates, but a programmatic start() must too.
  if (!(port == null || (Number.isInteger(port) && port >= 0 && port <= PORT_MAX)))
    throw new TypeError("listenChamber: port must be null (auto) or an integer in 0–" + PORT_MAX + ", got " + String(port));
  if (!(Number.isInteger(tries) && tries > 0))
    throw new TypeError("listenChamber: tries must be a positive integer, got " + String(tries));
  const auto = port == null;
  let candidate = auto ? pick() : port;
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise((res2, rej) => {
        let onError, onListening;
        const cleanup = () => { server.removeListener("error", onError); server.removeListener("listening", onListening); };
        onError = (e) => { cleanup(); rej(e); };
        onListening = () => { cleanup(); res2(); };
        server.once("error", onError);
        server.once("listening", onListening);
        // A synchronous listen() throw (e.g. bad server state) must still unhook both listeners.
        try { server.listen(candidate, host); } catch (e) { cleanup(); rej(e); }
      });
      return candidate;
    } catch (e) {
      if (auto && e && e.code === "EADDRINUSE" && attempt < tries) { candidate = pick(); continue; }
      throw e;
    }
  }
}

// Start the chamber. Resolves the workspace, binds 127.0.0.1, returns the live server.
// `port` is overridable for tests (0 = OS-ephemeral); `null`/undefined = auto-pick a random 5-digit
// port with retry (see listenChamber). `host` is overridable too. Never binds beyond localhost.
export async function start({ cwd = process.cwd(), out = "gazette", port = null, host = "127.0.0.1", watch = false } = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("bureau serve binds loopback only — refusing host " + host);
  const wsDir = workspaceDir(cwd);
  if (!wsDir) throw new Error("no bureau workspace found in " + cwd + " — run bureau:init first");
  const ctx = {
    wsDir, wsName: wsDir.slice(dirname(wsDir).length + 1), outDir: resolve(cwd, out),
    // time + entropy: two chambers on one workspace started in the same millisecond must not share
    // a session id (it namespaces every minute filename — a collision would spuriously 500).
    sessionId: "chamber-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex"), reviewToken: randomBytes(16).toString("hex"),
    _seq: 0, nextSeq() { return ++this._seq; },
  };
  // `handle` returns a promise on the POST routes; route both synchronous throws AND that promise's
  // rejection here so a handler error becomes a 500 (not an unhandled rejection that can crash Node).
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handle(req, res, ctx)).catch(() =>
      safe(() => { if (!res.headersSent) sendJson(res, 500, { err: "internal error" }); else res.end(); }, null));
  });
  await listenChamber(server, host, port);
  let watcher = null;
  if (watch) {
    // serialize rebuilds: never run two gazette builds over the same out dir at once; a change
    // arriving mid-build coalesces into a single follow-up build.
    let building = false, again = false;
    const build = async () => { if (building) { again = true; return; } building = true; try { do { again = false; await rebuildGazette(ctx); } while (again); } finally { building = false; } };
    watcher = makeWatcher(wsDir, build);
    if (!watcher.supported) safe(() => process.stderr.write("bureau serve: recursive watch unsupported here — live-rebuild disabled\n"), null);
  }
  const close = () => { safe(() => watcher && watcher.close(), null); server.close(); };
  return { server, watcher, close, wsDir, wsName: ctx.wsName, host, port: server.address().port, sessionId: ctx.sessionId, reviewToken: ctx.reviewToken };
}

// internal helpers exported for unit tests (not a public API)
export const _internal = { workspaceDir, containedUnder, safeId, writeIntake, listenChamber, randomPort, PORT_MIN, PORT_MAX };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  // No --port → null → auto-pick a random 5-digit port (retrying on collision). A pinned --port is
  // validated and honored strictly.
  const pinned = args.includes("--port");
  let port = null;
  if (pinned) {
    port = Number(opt("port", ""));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { process.stderr.write("bureau serve: --port must be an integer in 1024–65535\n"); process.exit(1); }
  }
  start({ out: opt("out", "gazette"), port, host: opt("host", "127.0.0.1"), watch: args.includes("--watch") })
    .then(({ host, port, wsName, reviewToken, watcher }) => process.stdout.write(
      "bureau chamber → http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port + "  (workspace: " + wsName + ")\n" +
      "  Reviewer token (paste in the chamber to approve/reject): " + reviewToken + "\n" +
      (watcher && watcher.supported ? "  Watching the workspace — the gazette rebuilds on change.\n" : "") +
      "  Ctrl-C to stop.\n"))
    .catch((e) => {
      // Only a user-pinned port earns the "drop --port" hint; an auto-pick that exhausted its
      // retries never had a --port to drop, so it gets a distinct message.
      const hint = e && e.code === "EADDRINUSE"
        ? (pinned ? " — that port is taken; drop --port to auto-pick a free one"
                  : " — could not find a free port after retrying; try again")
        : "";
      process.stderr.write("bureau serve: " + e.message + hint + "\n"); process.exit(1);
    });
}
