#!/usr/bin/env node
// gazette — offline knowledge-base board: gazette/*.html → self-contained static site.
//   gazette init                  scaffold gazette/_config.json + a sample in the current dir
//   gazette build [opts]          build dist/
//   gazette serve [--port 8080]   build, then serve dist/ locally
// opts: --docs <dir>(=docs)  --data <dir>(=data)  --out <dir>(=dist)
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, lstatSync, readdirSync, realpathSync, watch } from "fs";
import { join, resolve, dirname, extname, sep, relative } from "path";
import { createServer } from "http";
import { spawn } from "child_process";
import { buildSite, computeHealth } from "../src/build.mjs";
import { renderHealthText } from "../src/render/health-report.mjs";
import { healthTotal, countsTotal } from "../src/derive/health.mjs";
import { parseDate } from "../src/services/dates.mjs";
import { planRename, applyRename } from "../src/maintain/rename.mjs";
import { buildRepairPlan, applySafe, renderRepairText } from "../src/maintain/doctor.mjs";
import { escapeHtml } from "../src/shared/escape.mjs";
import { prettify } from "../src/shared/prettify.mjs";
// recursion engine (ADR-0001): scan → gate → fsck → report + ledgers
import { scan as engineScan } from "../src/engine/scan.mjs";
import { computeGate } from "../src/engine/gate.mjs";
import { fsck as engineFsck } from "../src/engine/fsck.mjs";
import { report as engineReport, renderMetricsText } from "../src/engine/metrics.mjs";
import { recordVerification, recheckVerification, markCompiled, uncompiled } from "../src/engine/ledgers.mjs";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { logPath, readLog, appendEvent } from "../src/engine/log.mjs";
import { conflictKey } from "../src/engine/state.mjs";
import { buildAtRef, logDiff, snapshotCreate, readSnapshots, resolveSnapshotOrRef } from "../src/engine/versions.mjs";
import { nfc } from "../src/services/i18n.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function opt(name, def) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : def; // a following flag is not this option's value (grill L6)
}

// today's date (YYYY-MM-DD) as the default staleness baseline; --now overrides. LOCAL date parts,
// not toISOString() (which is UTC) — near midnight a UTC baseline can be a day off for the user.
function today() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function die(msg) { console.error("✗ " + msg); process.exit(1); }

// content dir: --dir (or legacy --docs); engine defaults to "gazette" when omitted
function dirArg() { return opt("dir") || opt("docs"); }
function dataArg() { return opt("data"); }

// validated staleness baseline — a bad --now must fail loud, never silently disable
// staleness and exit green (grill H6).
function nowArg() {
  const v = opt("now", today());
  if (!parseDate(v).valid) die('--now must be a valid YYYY-MM-DD (got: "' + v + '")');
  return v;
}

function runBuild() {
  if (argv.includes("--at")) { const v = opt("at"); if (!v) die("--at needs a ref or snapshot name (e.g. --at HEAD)"); return runBuildAt(v); }
  try {
    const r = buildSite({ docsDir: dirArg(), dataDir: dataArg(), outDir: opt("out"), now: nowArg() });
    const bits = [r.fileDocCount + " documents"];
    if (r.coldCount) bits.push("cold events " + r.coldCount + " → sequence diagrams + daily table");
    if (r.themeOverride) bits.push("theme.css override");
    if (r.assetsCopied) bits.push("assets/ copied");
    const total = countsTotal(r.health); // r.health is the counts object (build.mjs); hand-summing it drops new lanes
    bits.push("health " + (r.healthClean ? "✅" : "⚠ " + total + (total === 1 ? " item" : " items")));
    bits.push("drift " + freshnessBit(r));
    console.log("✓ build: " + bits.join(", ") + " (" + r.totalDocs + " pages) -> " + r.outDir);
    return r;
  } catch (e) {
    die(e.message);
  }
}

// live engine freshness, one-line: integrity failure first, then ✅ / the needs-review/stale/modified tally.
function freshnessBit(r) {
  if (r.freshnessIntact === false) return "⚠ decision-log integrity FAILED — run `gazette fsck`";
  const f = r.freshness || { needsReview: 0, stale: 0, modified: 0 };
  const n = (f.needsReview || 0) + (f.stale || 0) + (f.modified || 0);
  if (!n) return "✅";
  const parts = [];
  if (f.needsReview) parts.push(f.needsReview + " need review");
  if (f.stale) parts.push(f.stale + " stale");
  if (f.modified) parts.push(f.modified + " modified");
  if (r.freshnessPending) parts.push(r.freshnessPending + " unscanned");
  return "⚠ " + parts.join(" · ");
}

// recursive fs.watch isn't supported on Linux before Node 20 (throws
// ERR_FEATURE_UNAVAILABLE_ON_PLATFORM). Try it; on failure, fall back to a non-recursive
// watch on the dir and each of its (symlink-free) subdirectories. Returns nothing.
function watchTree(dir, cb) {
  try { watch(dir, { recursive: true }, cb); return; }
  catch (e) { if (e && e.code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw e; }
  const walk = (d) => {
    try { watch(d, cb); } catch { /* unwatchable dir → skip */ }
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      if (ent.name.startsWith("_") || ent.name.startsWith(".") || ent.name === "dist" || ent.name === "node_modules") continue;
      walk(join(d, ent.name));
    }
  };
  walk(dir);
  console.warn("⚠ recursive watch unavailable on this platform/Node — watching subdirectories individually (new top-level folders won't auto-watch until restart)");
}

function runWatch() {
  const root = process.cwd();
  const docsDir = resolve(root, dirArg() || "gazette");
  const dataDir = dataArg() ? resolve(root, dataArg()) : undefined;
  const build = () => {
    try {
      // recompute the baseline each rebuild (nowArg falls back to today()), so a watcher left
      // running past midnight uses the current date for staleness, not the start-of-process one.
      const r = buildSite({ root, docsDir, dataDir, outDir: opt("out"), now: nowArg(), force: true });
      console.log((r.cached ? "· unchanged" : "✓ rebuilt") + " (health " + (r.healthClean ? "✅)" : "⚠)"));
    } catch (e) { console.error("✗ " + e.message); }
  };
  build();
  let timer = null;
  const trigger = () => { clearTimeout(timer); timer = setTimeout(build, 150); }; // debounce
  if (existsSync(docsDir)) watchTree(docsDir, trigger);
  for (const f of ["theme.json", "theme.css"]) { const p = join(root, f); if (existsSync(p)) watch(p, trigger); }
  console.log("👀 watching " + relative(root, docsDir) + " + theme (Ctrl-C to stop)");
}

// ── WRITE lane (maintainer): rename + doctor edit docs/, the SSOT. ──
function runRename() {
  const from = argv[1], to = argv[2];
  if (!from || !to || from.startsWith("--") || to.startsWith("--")) die('usage: gazette rename "<old title>" "<new title>" [--dry]');
  try {
    const docsDir = resolve(process.cwd(), dirArg() || "gazette");
    const plan = planRename({ docsDir, from, to });
    if (!plan.edits.length) { console.log("no changes."); return; }
    if (argv.includes("--dry")) {
      console.log("will change " + plan.edits.length + " files / " + plan.linkTotal + " links: ");
      for (const e of plan.edits) console.log("  " + e.file + (e.titleChanged ? " (incl. title)" : "") + " · " + e.links + " links");
      return;
    }
    const r = applyRename(plan, docsDir);
    console.log('✓ rename [' + from + '] -> [' + to + '] changed ' + r.files + ' files, ' + r.links + ' links. run build to apply. ');
  } catch (e) { die(e.message); }
}

function runDoctor() {
  try {
    const root = process.cwd();
    const docsDir = resolve(root, dirArg() || "gazette");
    const { model, health } = computeHealth({ docsDir, dataDir: dataArg() ? resolve(root, dataArg()) : undefined, now: nowArg() });
    const fixes = buildRepairPlan(model, health);
    const applied = argv.includes("--apply") ? applySafe(docsDir, fixes, model) : [];
    console.log(renderRepairText(fixes, applied));
    process.exit(fixes.length === 0 ? 0 : 1); // non-zero when maintenance is still needed
  } catch (e) { die(e.message); }
}

function runHealth() {
  try {
    const root = process.cwd();
    const { health } = computeHealth({
      docsDir: resolve(root, dirArg() || "gazette"),
      dataDir: dataArg() ? resolve(root, dataArg()) : undefined,
      now: nowArg(),
    });
    console.log(renderHealthText(health));
    process.exit(healthTotal(health) === 0 ? 0 : 1); // non-zero exit when findings exist (CI-friendly)
  } catch (e) {
    die(e.message);
  }
}

function runInit() {
  const root = process.cwd();
  const base = dirArg() || "gazette";
  const dir = resolve(root, base);
  // refuse a symlinked content dir — scaffolding through it would write files outside the workspace.
  try { if (lstatSync(dir).isSymbolicLink()) die("content directory is a symlink (refused): " + base); } catch { /* absent → fine, mkdir below */ }
  mkdirSync(dir, { recursive: true });
  const writeIf = (rel, content) => {
    const p = join(dir, rel);
    if (existsSync(p)) { console.log("· exists, skipping: " + base + "/" + rel); return; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    console.log("+ " + base + "/" + rel);
  };
  // _config.json is optional (sections derive from folders); it just sets title/home.
  writeIf("_config.json", JSON.stringify({ meta: { title: "Untitled", subtitle: "workboard", home: "Overview" } }, null, 2) + "\n");
  writeIf("00-overview.html", [
    '<article data-title="Overview" data-icon="home" data-type="panorama" data-status="draft">',
    "  <h1>Overview</h1>",
    "  <blockquote><p>One-line premise here.</p></blockquote>",
    "  <p>Sidebar sections come from <strong>folders</strong>. This file is at the root; [[Lin]] lives in <code>characters/</code>, so it shows under a “Characters” section.</p>",
    '  <div class="viz" data-type="chart" data-kind="bar" data-format="csv">label,value',
    "1,12",
    "2,19</div>",
    "</article>",
    "",
  ].join("\n"));
  writeIf(join("characters", "lin.html"), [
    '<article data-icon="user" data-status="draft">',
    "  <h1>Lin</h1>",
    "  <p>A doc in <code>characters/</code> → the “Characters” sidebar section. Back to [[Overview]].</p>",
    "</article>",
    "",
  ].join("\n"));

  const giPath = join(root, ".gitignore");
  // refuse to append through a symlinked .gitignore (it could point at an arbitrary target).
  try { if (lstatSync(giPath).isSymbolicLink()) die(".gitignore is a symlink (refused): " + giPath); } catch { /* absent → created below */ }
  const has = existsSync(giPath) && readFileSync(giPath, "utf8").split(/\r?\n/).some((l) => l.trim() === "dist/");
  if (!has) { appendFileSync(giPath, "dist/\n"); console.log("+ .gitignore: dist/"); }

  console.log("\nNext: gazette serve   (builds, watches " + base + "/, and hot-reloads your browser)");
}

// create a new doc at <folder>/<slug> inside the content dir, with a minimal skeleton
function runNew() {
  const target = argv[1];
  if (!target || target.startsWith("--")) die('usage: gazette new <folder>/<slug> ["Title"]');
  const titleArg = argv[2] && !argv[2].startsWith("--") ? argv[2] : null;
  const root = process.cwd();
  const base = dirArg() || "gazette";
  const dir = resolve(root, base);
  if (!existsSync(dir)) die("no " + base + "/ here — run `gazette init` first");
  const rel = target.replace(/\\/g, "/").replace(/\.html$/, "") + ".html";
  const fp = resolve(dir, rel);
  if (!(fp === dir || fp.startsWith(dir + sep))) die("path escapes the content dir: " + target);
  if (existsSync(fp)) die("already exists: " + base + "/" + rel);
  // Lexical containment isn't enough: a symlinked subdir inside the content dir could
  // redirect the write outside the real tree. Realpath the deepest existing ancestor and
  // confirm it still resolves inside the real content dir before writing.
  const dirReal = realpathSync(dir);
  let anc = dirname(fp);
  while (!existsSync(anc) && anc !== dirname(anc)) anc = dirname(anc);
  const ancReal = realpathSync(anc);
  if (!(ancReal === dirReal || ancReal.startsWith(dirReal + sep))) die("path escapes the content dir (via symlink): " + target);
  const title = titleArg || prettify(rel.split("/").pop().replace(/\.html$/, ""));
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, '<article data-updated="' + today() + '">\n  <h1>' + escapeHtml(title) + "</h1>\n  <p></p>\n</article>\n");
  console.log("+ " + base + "/" + rel + '   (title "' + title + '")');
}

// build once and open dist/index.html in the default browser (no watch)
function runOpen() {
  const r = runBuild();
  const idx = join(r.outDir, "index.html");
  const win = process.platform === "win32";
  // Windows: rundll32 FileProtocolHandler takes the path as a single literal argument, so a
  // checkout path with cmd metacharacters (& | ^ …) can't be reinterpreted by a shell — unlike
  // `cmd /c start`. macOS: open; Linux: xdg-open (both pass the path as one argv).
  const opener = process.platform === "darwin" ? "open" : win ? "rundll32" : "xdg-open";
  const args = win ? ["url.dll,FileProtocolHandler", idx] : [idx];
  // spawn reports a missing opener (no `xdg-open` on a headless box) ASYNCHRONOUSLY, via an
  // 'error' event — try/catch never sees it, so the old code printed "opened" and then died on
  // an unhandled error. Handle the event; only claim success once the child is actually up.
  const fallback = () => console.log("open this in your browser: " + idx);
  try {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.once("error", fallback);
    child.once("spawn", () => { console.log("→ opened " + idx); child.unref(); });
  } catch { fallback(); }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json",
};

// serve = the dev experience: build once, serve dist/ on localhost, watch the content
// dir + theme, rebuild on every save, and HOT-RELOAD the browser over SSE. The shipped
// dist/ stays strict-CSP/offline; only the SERVED response is rewritten (reload client
// injected + connect-src relaxed to 'self') so live-reload works in dev.
const RELOAD_CLIENT = "var es=new EventSource('/__wb_reload');es.onmessage=function(e){if(e.data==='reload')location.reload();};";
function runServe() {
  const port = +opt("port", "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) die("--port must be an integer in 1-65535 (got: " + opt("port", "8080") + ")");
  const root = process.cwd();
  const docsDir = resolve(root, dirArg() || "gazette");
  const dataDir = dataArg() ? resolve(root, dataArg()) : undefined;
  const out = resolve(root, opt("out") || "dist");
  // recompute the baseline each rebuild so a long-running server past midnight uses the current date.
  const doBuild = () => { try { return buildSite({ root, docsDir, dataDir, outDir: opt("out"), now: nowArg(), force: true }); } catch (e) { console.error("✗ " + e.message); return null; } };
  if (!doBuild()) die("initial build failed — fix the error above and re-run");
  const outReal = realpathSync(out);
  const within = (q, base) => q === base || q.startsWith(base + sep);
  const clients = new Set(); // open SSE responses

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/__wb_reload") { // SSE live-reload channel
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (clients.size >= 64) { res.end(); return; } // cap live-reload connections so leaked/looping clients can't exhaust fds
      res.write("retry: 1000\n\n"); clients.add(res); req.on("close", () => clients.delete(res));
      return;
    }
    if (url === "/__wb_reload.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }); res.end(RELOAD_CLIENT); return; }
    let p;
    try { p = decodeURIComponent(url); } // malformed %-encoding is a bad request, not a server fault
    catch { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("400 bad request"); return; }
    try {
      if (p === "/" || p.endsWith("/")) p += "index.html";
      const fp = resolve(out, "." + p);
      if (!within(fp, out) || !existsSync(fp) || statSync(fp).isDirectory()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("404 " + p); return; }
      const real = realpathSync(fp); // follow symlinks, then re-check against the realpath'd root (grill M3)
      if (!within(real, outReal)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("403"); return; }
      if (!statSync(real).isFile()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("404 " + p); return; } // only regular files (a FIFO/device could block readFileSync)
      if (extname(real) === ".html") {
        const html = readFileSync(real, "utf8")
          .replace("connect-src 'none'", "connect-src 'self'")               // dev-only: allow the SSE channel
          .replace("</body>", '<script src="/__wb_reload.js"></script></body>');
        res.writeHead(200, { "content-type": MIME[".html"] }); res.end(html); return;
      }
      res.writeHead(200, { "content-type": MIME[extname(real)] || "application/octet-stream" });
      res.end(readFileSync(real));
    } catch (e) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("500"); }
  });
  server.on("error", (e) => die("serve failed to start: " + e.message));
  server.listen(port, "127.0.0.1", () => console.log("\n→ http://127.0.0.1:" + port + "   (hot reload on; Ctrl-C to stop)"));

  // watch the content dir + project theme; debounce; rebuild; tell the browser to reload
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = doBuild();
      if (!r) return;
      console.log("✓ rebuilt · " + r.totalDocs + " pages · health " + (r.healthClean ? "✅" : "⚠") + " · drift " + freshnessBit(r));
      for (const c of clients) { try { c.write("data: reload\n\n"); } catch (_) { /* dropped */ } }
    }, 150);
  };
  if (existsSync(docsDir)) watchTree(docsDir, trigger);
  for (const f of ["theme.json", "theme.css"]) { const p = join(root, f); if (existsSync(p)) watch(p, trigger); }
}

// ── recursion engine (ADR-0001) ────────────────────────────────────────────────
function engineDir() { return resolve(process.cwd(), dirArg() || "gazette"); }

// ── versioned board (git-backed): render a past board, diff two versions, pin named snapshots ──
// build --at <ref|snapshot>: render the board AS OF a git commit (via a detached worktree).
function runBuildAt(ref) {
  try {
    const root = process.cwd();
    const docsDirAbs = engineDir();
    // resolve a snapshot NAME or a git ref → the concrete commit (so named snapshots work, and the
    // default output dir is keyed by the UNIQUE commit hash — distinct refs never collide).
    const sha = resolveSnapshotOrRef({ root, docsDirAbs, ref });
    const outDirAbs = resolve(root, opt("out") || ("dist-at-" + sha.slice(0, 12)));
    const r = buildAtRef({ root, ref: sha, docsDirAbs, outDirAbs, now: nowArg(), buildSite });
    console.log("✓ build @" + ref + " (" + r.commit.slice(0, 8) + "): " + r.fileDocCount + " documents (" + r.totalDocs + " pages) -> " + r.outDir);
  } catch (e) { die(e.message); }
}

// diff <A> <B>: what changed between two versions, read from the decision-log slice + ledger drift.
function runDiff() {
  try {
    const a = argv[1], b = argv[2];
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) die("usage: gazette diff <refA|snapshot> <refB|snapshot>");
    const d = logDiff({ root: process.cwd(), refA: a, refB: b, docsDirAbs: engineDir() });
    console.log("diff " + a + " (" + d.commitA.slice(0, 8) + ", seq " + d.fromSeq + ") → " + b + " (" + d.commitB.slice(0, 8) + ", seq " + d.toSeq + "): " + d.newEvents + " new log event(s)");
    for (const t of ["introduce", "edit", "delete", "rename", "split", "confirm-edge", "approve", "reject", "resolve"]) {
      const evs = d.by[t]; if (!evs || !evs.length) continue;
      const label = (e) => e.id ? e.id + (e.span ? " " + e.span : "") : (e.edge ? "edge " + e.edge.slice(0, 8) : (e.conflict || ""));
      console.log("  " + t + " ×" + evs.length + ": " + evs.slice(0, 8).map(label).join(", ") + (evs.length > 8 ? " …" : ""));
    }
    for (const ad of d.artifactDrift) console.log("  artifact-drift (" + ad.kind + "): [" + ad.page + "] → " + ad.artifact);
    if (!d.newEvents && !d.artifactDrift.length) console.log("  (no decision-log changes between these versions)");
  } catch (e) { die(e.message); }
}

// snapshot create <name> | list: pin a named, reproducible version {commit, log-seq, fsck digest}.
function runSnapshot() {
  try {
    const action = argv[1];
    const root = process.cwd(), docsDirAbs = engineDir();
    if (action === "create") {
      const name = argv[2];
      if (!name || name.startsWith("--")) die('usage: gazette snapshot create <name> [--note "…"]');
      // digest describes the engine state. If there's no decision log yet, pin without one; but any
      // OTHER fsck failure (tampered log, malformed corpus, broken ledger) is a real problem — let it
      // propagate rather than silently create a digestless snapshot.
      const digest = existsSync(logPath(docsDirAbs)) ? engineFsck({ docsDir: docsDirAbs, write: false }).digest : null;
      const e = snapshotCreate({ root, docsDirAbs, name, note: opt("note"), digest });
      console.log('✓ snapshot "' + e.name + '" → commit ' + e.commit.slice(0, 8) + ", log seq " + e.seq + (e.digest ? ", digest " + e.digest.slice(0, 12) : "") + "  (commit + push to preserve)");
    } else if (action === "list" || action == null) {
      const snaps = readSnapshots(docsDirAbs);
      if (!snaps.length) { console.log("no snapshots — create one with: gazette snapshot create <name>"); return; }
      for (const s of snaps) console.log("  " + s.name + "  " + s.commit.slice(0, 8) + "  seq " + s.seq + (s.note ? "  — " + s.note : ""));
    } else die("usage: gazette snapshot <create|list> …");
  } catch (e) { die(e.message); }
}

// scan: reconcile the decision log with the current corpus (the mechanical event producer).
function runScan() {
  try {
    const docsDir = engineDir();
    const r = engineScan({ docsDir, apply: !argv.includes("--dry") });
    const s = r.summary;
    const verb = argv.includes("--dry") ? "would append" : "appended";
    console.log("✓ scan: " + verb + " " + r.planned.length + " event(s) — " + s.introduced + " introduce, " + s.edited + " edit, " + s.deleted + " delete");
  } catch (e) { die(e.message); }
}

// gate: print the eager dirty index + cutoff ratio BESIDE edge count (never alone).
function runGate() {
  try {
    const docsDir = engineDir();
    const model = buildModel({ corpus: loadCorpus({ docsDir }) });
    const g = computeGate({ model, events: readLog(logPath(docsDir)) });
    const c = g.counts;
    console.log("gate: " + c.tracked + " tracked edges · " + g.dirty.length + " dirty pages · cutoff ratio " +
      (g.cutoffRatio == null ? "n/a" : (g.cutoffRatio * 100).toFixed(1) + "%") + " · " + c.untracked + " untracked · " + c.broken + " broken");
    for (const d of g.dirty) console.log("  " + (d.freshness === "stale" ? "✗ stale       " : "· needs-review") + " " + d.uid);
    process.exit(0); // the gate is informational; broken/dirty is expected mid-work
  } catch (e) { die(e.message); }
}

// fsck: rebuild the mechanical-derived tier to a byte-fixpoint. Non-zero on a broken fixpoint OR any
// BLOCKING finding (unbacked-canonical, orphan-confirm, ledger-malformed); pending-scan is advisory.
function runFsck() {
  try {
    const docsDir = engineDir();
    const r = engineFsck({ docsDir, write: !argv.includes("--check") });
    console.log("fsck: " + r.nodeCount + " pages · fixpoint " + (r.fixpointStable ? "stable ✅" : "UNSTABLE ✗") + " · digest " + r.digest.slice(0, 12) + " · " + r.findings.length + " finding(s)");
    for (const f of r.findings) console.log("  " + (r.blockingFindings.includes(f) ? "✗" : "·") + " " + f.kind + (f.uid ? " " + f.uid : "") + (f.detail ? " — " + f.detail : "") + (f.count ? " ×" + f.count : ""));
    process.exit(r.ok ? 0 : 1); // r.ok = fixpoint stable AND no blocking findings
  } catch (e) { die(e.message); } // a tampered log throws here → non-zero
}

// report: the deterministic, auditable metrics block. Exit tracks r.ok (fixpoint + broken edges +
// mutation survivors + blocking findings) — a "needs attention" report never returns success.
function runReport() {
  try {
    const r = engineReport({ docsDir: engineDir() });
    console.log(renderMetricsText(r));
    process.exit(r.ok ? 0 : 1);
  } catch (e) { die(e.message); }
}

// resolve a page TITLE to its opaque uid + node (the decision-event verbs address pages by title).
function resolvePage(docsDir, title) {
  const model = buildModel({ corpus: loadCorpus({ docsDir }) });
  const node = model.nodes[nfc(String(title))];
  if (!node) die('no page titled [' + title + ']');
  return { model, node };
}

// decision-event API (ADR-0001, Schema 1) — the human/review side of the log. In 0.8 the review
// skill drives these; in 0.7 they are the CLI surface that gives the gate a real event stream.
function runApprove() {
  try {
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if (!title) die('usage: gazette approve "<page title>"');
    const docsDir = engineDir();
    const { node } = resolvePage(docsDir, title);
    const ev = appendEvent(logPath(docsDir), { type: "approve", id: node.uid, to_trust: "canonical", by: opt("by", "human") });
    console.log("✓ approved [" + node.title + "] → trust: canonical (backed by log seq " + ev.seq + ")");
  } catch (e) { die(e.message); }
}
function runReject() {
  try {
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if (!title) die('usage: gazette reject "<page title>" [--reason "…"]');
    const docsDir = engineDir();
    const { node } = resolvePage(docsDir, title);
    appendEvent(logPath(docsDir), { type: "reject", id: node.uid, reason: opt("reason", "") });
    console.log("✓ rejected [" + node.title + "] (logged; the page's authored tier stands, no canonical backing)");
  } catch (e) { die(e.message); }
}
// confirm every currently-open tracked edge OF a dependent page (the human vouches the edge holds).
function runConfirm() {
  try {
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if (!title) die('usage: gazette confirm "<dependent page title>"');
    const docsDir = engineDir();
    const { node, model } = resolvePage(docsDir, title);
    const g = computeGate({ model, events: readLog(logPath(docsDir)) });
    let n = 0, skippedBroken = 0;
    for (const e of g.edges) {
      if (!e.tracked || !e.open || e.dep !== node.uid) continue;
      // never confirm a BROKEN edge (missing target / missing span) — it has no valid verdict key to
      // vouch for; confirming it would append a bogus/empty confirmation and falsely report success.
      if (e.broken || !e.edgeId || !e.verdictKey) { skippedBroken++; continue; }
      appendEvent(logPath(docsDir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey, by: opt("by", "human") });
      n++;
    }
    const note = skippedBroken ? " (skipped " + skippedBroken + " broken edge(s) — fix the target/span first)" : "";
    console.log((n ? "✓ confirmed " + n + " edge(s) for [" + node.title + "]" : "no confirmable open edges for [" + node.title + "]") + note);
  } catch (e) { die(e.message); }
}
// resolve a `contradicts` conflict: record which page wins. The resolution is a log event; the
// projection turns `conflict: contested` into `resolved` with a resolution_id (ADR-0001, §4.18 seed).
function runResolve() {
  try {
    const a = argv[1], b = argv[2];
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) die('usage: gazette resolve "<page A>" "<page B>" --winner "<title>"');
    const docsDir = engineDir();
    const model = buildModel({ corpus: loadCorpus({ docsDir }) });
    const na = model.nodes[nfc(String(a))], nb = model.nodes[nfc(String(b))];
    if (!na) die("no page titled [" + a + "]");
    if (!nb) die("no page titled [" + b + "]");
    const winner = opt("winner");
    if (!winner) die('resolve needs --winner "<title>"');
    const wn = model.nodes[nfc(String(winner))];
    if (!wn || (wn.uid !== na.uid && wn.uid !== nb.uid)) die("--winner must be one of the two named pages");
    const ev = appendEvent(logPath(docsDir), { type: "resolve", conflict: conflictKey(na.uid, nb.uid), winner: wn.uid });
    console.log("✓ resolved [" + na.title + "] × [" + nb.title + "] → winner [" + wn.title + "] (resolution_id " + ev.seq + ")");
  } catch (e) { die(e.message); }
}

// ledger: the mechanical trust ledgers, callable by the compile/review skills.
function runLedger() {
  try {
    const action = argv[1];
    const docsDir = engineDir();
    const root = process.cwd();
    if (action === "verify") {
      const page = opt("page"), artifact = opt("artifact"), claim = opt("claim");
      if (!page || !artifact) die('usage: gazette ledger verify --page "<title>" --artifact <repo-relative-path> [--claim "<c>"]');
      const hash = recordVerification(docsDir, { root, page, artifact, claim, date: opt("now", today()) });
      console.log("✓ verified " + artifact + " for [" + page + "] — sha256 " + hash.slice(0, 12));
    } else if (action === "recheck") {
      const page = opt("page"); if (!page) die('usage: gazette ledger recheck --page "<title>"');
      const rows = recheckVerification(docsDir, { root, page });
      if (!rows.length) { console.log("no recorded fingerprints for [" + page + "]"); return; }
      for (const c of rows) console.log("  " + (c.ok ? "✅ current " : "✗ DRIFTED ") + c.artifact);
      process.exit(rows.every((c) => c.ok) ? 0 : 1);
    } else if (action === "mark-compiled") {
      const ids = argv.slice(2).filter((a) => !a.startsWith("--"));
      if (!ids.length) die("usage: gazette ledger mark-compiled <session-id> [<session-id>...]");
      console.log("✓ marked " + markCompiled(docsDir, ids) + " new session(s) compiled");
    } else if (action === "uncompiled") {
      const ids = argv.slice(2).filter((a) => !a.startsWith("--"));
      const out = uncompiled(docsDir, ids);
      console.log(out.length ? out.join("\n") : "(all compiled)");
    } else {
      die("usage: gazette ledger <verify|recheck|mark-compiled|uncompiled> …");
    }
  } catch (e) { die(e.message); }
}

switch (cmd) {
  case "init": runInit(); break;
  case "new": runNew(); break;
  case "serve": runServe(); break;
  case "build": runBuild(); break;
  case "open": runOpen(); break;
  case "watch": runWatch(); break;
  case "health": case "audit": runHealth(); break;
  case "doctor": runDoctor(); break;
  case "rename": runRename(); break;
  case "scan": runScan(); break;
  case "gate": runGate(); break;
  case "fsck": runFsck(); break;
  case "report": runReport(); break;
  case "ledger": runLedger(); break;
  case "approve": runApprove(); break;
  case "reject": runReject(); break;
  case "confirm": runConfirm(); break;
  case "resolve": runResolve(); break;
  case "diff": runDiff(); break;
  case "snapshot": runSnapshot(); break;
  default:
    console.log([
      "gazette — offline board from a folder of HTML docs (default: gazette/)",
      "",
      "  setup & dev:",
      "  gazette init                       scaffold gazette/ (sample folders) + .gitignore dist/",
      "  gazette serve [--port 8080]        build + watch + HOT-RELOAD in the browser (the everyday command)",
      "  gazette new <folder>/<slug> [Title]  create a new doc in a folder",
      "",
      "  build & view:",
      "  gazette build [--out --now]        one-shot build → dist/ (shareable offline artifact)",
      "  gazette open                       build, then open dist/index.html",
      "  gazette watch                      rebuild on save (no server)",
      "",
      "  maintain the knowledge base:",
      "  gazette audit  (alias: health)     deterministic check: dangling/orphan/contradiction/stale/schema/drift/unsourced",
      "  gazette doctor [--apply]           audit → repair plan (--apply fixes the safe subset)",
      '  gazette rename "<old>" "<new>" [--dry]  rename a doc + propagate every reference',
      "",
      "  recursion engine (ADR-0001):",
      "  gazette scan [--dry]               reconcile the decision log with the corpus (span-revision events)",
      "  gazette gate                       show the eager dirty index (needs-review/stale) + cutoff ratio",
      "  gazette fsck [--check]             rebuild mechanical-derived state to a byte-fixpoint (CI gate)",
      "  gazette report                     deterministic auditable metrics (kill rate, fixpoint, cutoff)",
      '  gazette approve "<title>"          log a human approval → trust: canonical (backs the projection)',
      '  gazette confirm "<title>"          vouch a dependent page\'s open rests_on edges (gate cutoff)',
      '  gazette resolve "<A>" "<B>" --winner "<title>"   record a contradicts resolution',
      "  gazette ledger <verify|recheck|mark-compiled|uncompiled> …   the code-owned trust ledgers",
      "",
      "  versioned board (git-backed):",
      "  gazette build --at <ref|snapshot>  render the board AS OF a git commit (own out dir by default)",
      "  gazette diff <A> <B>               what changed between two versions (decision-log slice + drift)",
      "  gazette snapshot create <name>     pin a named version {commit, log-seq, digest}",
      "  gazette snapshot list              list pinned snapshots",
      "",
      "  common flags: --dir <dir> (content dir, default gazette/)  --data <dir>  --out <dir>  --now YYYY-MM-DD",
    ].join("\n"));
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
