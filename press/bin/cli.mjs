#!/usr/bin/env node
// ⚠ BUILD-TIME SOURCE ENTRY — not the runnable distributable. This imports ../src/*.mjs, which
// depend on node_modules (node-html-parser, markdown-it, sanitize-html). The shipped plugin ships
// no node_modules, so running THIS directly fails with ERR_MODULE_NOT_FOUND. `scripts/build-gazette.mjs`
// esbuild-bundles it into the self-contained `bin/gazette.mjs` — THAT is what every skill/command runs
// and what `package.json`'s `bin` points at. To run the CLI, use `bin/gazette.mjs`.
//
// gazette — offline knowledge-base board: gazette/*.html → self-contained static site.
//   gazette init                  scaffold gazette/_config.json + a sample in the current dir
//   gazette build [opts]          build dist/
//   gazette serve [--port 8080]   build, then serve dist/ locally
// opts: --docs <dir>(=docs)  --data <dir>(=data)  --out <dir>(=dist)
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readSync, statSync, lstatSync, readdirSync, realpathSync, rmSync, watch } from "fs";
import { join, resolve, dirname, extname, sep, relative } from "path";
import { createServer } from "http";
import { spawn } from "child_process";
import { buildSite, computeHealth } from "../src/build.mjs";
import { renderHealthText } from "../src/render/health-report.mjs";
import { healthTotal, countsTotal } from "../src/derive/health.mjs";
import { parseDate } from "../src/services/dates.mjs";
import { planRename, applyRename } from "../src/maintain/rename.mjs";
import { buildRepairPlan, applySafe, renderRepairText } from "../src/maintain/doctor.mjs";
import { escapeHtml, stripControl } from "../src/shared/escape.mjs";
import { prettify } from "../src/shared/prettify.mjs";
// recursion engine (ADR-0001): scan → gate → fsck → report + ledgers
import { scan as engineScan } from "../src/engine/scan.mjs";
import { computeGate, blastRadius } from "../src/engine/gate.mjs";
import { loadPolicy, authorityClass, isAuthorized } from "../src/engine/policy.mjs";
import { fsck as engineFsck } from "../src/engine/fsck.mjs";
import { reviewQueue } from "../src/engine/review-queue.mjs";
import { report as engineReport, renderMetricsText } from "../src/engine/metrics.mjs";
import { projectTimeline, renderTimelineText } from "../src/engine/telemetry.mjs";
import { recordVerification, recheckVerification, markCompiled, uncompiled, logbookSessionIds } from "../src/engine/ledgers.mjs";
import { loadCorpus, buildModel } from "../src/core/model.mjs";
import { reviewDigest } from "../src/engine/review-digest.mjs";
import { legacyCandidates, legacyPath, LEGACY_BASENAME } from "../src/engine/legacy.mjs";
import { resolveWorkspace } from "../src/core/workspace-map.mjs";
import { logPath, readLog, appendEvent, appendBatch } from "../src/engine/log.mjs";
import { createHash, randomBytes } from "crypto";
import { conflictKey, projectDecisions } from "../src/engine/state.mjs";
import { buildAtRef, logDiff, snapshotCreate, readSnapshots, resolveSnapshotOrRef, gitRootFor } from "../src/engine/versions.mjs";
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

// Content dir for the RENDER + engine commands when --dir/--docs is omitted. In a BUREAU repo — a
// single `*/bureau.json` child of the cwd — use that workspace dir, so `gazette build` renders the
// canon instead of the `gazette/` board-OUTPUT dir. Otherwise the press's own default, "gazette".
// (The `init`/`new` scaffolders keep the plain "gazette" default — they create, they don't read.)
function contentDir() {
  const explicit = dirArg();
  if (explicit) return explicit; // an explicit --dir/--docs always wins
  // ADR-0003: if this repo carries a path-free `.bureau-id`, its workspace is EXTERNAL — resolve the
  // absolute path from the user-local mapping. Unpaired/rejected is a loud failure, never a silent
  // fall-through to the wrong dir.
  const res = resolveWorkspace(process.cwd());
  if (res.mode === "external") return res.dir;
  if (res.mode === "unpaired") die("this repo's bureau workspace is external but its .bureau-id ('" + res.id + "') is not paired on this machine — run: " + res.hint);
  if (res.mode === "rejected") die("this repo's external bureau workspace was refused: " + res.reason);
  // in-repo: exactly one `*/bureau.json` child → use it; 0 or ambiguous → the press default "gazette".
  try {
    const root = process.cwd();
    const ws = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(root, d.name, "bureau.json")))
      .map((d) => d.name);
    if (ws.length === 1) return ws[0];
  } catch { /* unreadable cwd → fall through to the default */ }
  return "gazette";
}
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
    const r = buildSite({ docsDir: contentDir(), dataDir: dataArg(), outDir: opt("out"), now: nowArg() });
    const bits = [r.fileDocCount + " documents"];
    if (r.coldCount) bits.push("cold events " + r.coldCount + " → sequence diagrams + daily table");
    if (r.themeOverride) bits.push("theme.css override");
    if (r.assetsCopied) bits.push("assets/ copied");
    const total = countsTotal(r.health); // r.health is the counts object (build.mjs); hand-summing it drops new lanes
    bits.push("health " + (r.healthClean ? "✅" : "⚠ " + total + (total === 1 ? " item" : " items")));
    bits.push("drift " + freshnessBit(r));
    // artifact currency + convergence: quiet unless they need attention (a drifted verified file, or a
    // thrashing canon) — surfaced in the terminal exactly like drift, detailed in the board's Engine view.
    // artifactError echoes a JSON parse message that can contain the malformed ledger's raw bytes —
    // sanitize control chars before it reaches the terminal (else a crafted _verify.json forges output).
    if (r.artifactError) bits.push("artifacts ⚠ ledger error (" + stripControl(r.artifactError) + ")");
    else if (r.artifacts && r.artifacts.drifted) bits.push("artifacts ⚠ " + r.artifacts.drifted + " drifted");
    if (r.convergence === "thrashing") bits.push("convergence ⚠ thrashing");
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
  const docsDir = resolve(root, contentDir());
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
    const docsDir = resolve(process.cwd(), contentDir());
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
    const docsDir = resolve(root, contentDir());
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
      docsDir: resolve(root, contentDir()),
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
  const docsDir = resolve(root, contentDir());
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
function engineDir() { return resolve(process.cwd(), contentDir()); }

// ── versioned board (git-backed): render a past board, diff two versions, pin named snapshots ──
// build --at <ref|snapshot>: render the board AS OF a git commit (via a detached worktree).
function runBuildAt(ref) {
  try {
    const docsDirAbs = engineDir();
    const root = gitRootFor(docsDirAbs); // ADR-0003: version against the WORKSPACE's own git repo, not process.cwd()
    // resolve a snapshot NAME or a git ref → the concrete commit (so named snapshots work, and the
    // default output dir is keyed by the UNIQUE commit hash — distinct refs never collide).
    const sha = resolveSnapshotOrRef({ root, docsDirAbs, ref });
    const outDirAbs = resolve(process.cwd(), opt("out") || ("dist-at-" + sha.slice(0, 12)));
    const r = buildAtRef({ root, ref: sha, docsDirAbs, outDirAbs, now: nowArg(), buildSite });
    console.log("✓ build @" + ref + " (" + r.commit.slice(0, 8) + "): " + r.fileDocCount + " documents (" + r.totalDocs + " pages) -> " + r.outDir);
  } catch (e) { die(e.message); }
}

// diff <A> <B>: what changed between two versions, read from the decision-log slice + ledger drift.
function runDiff() {
  try {
    const a = argv[1], b = argv[2];
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) die("usage: gazette diff <refA|snapshot> <refB|snapshot>");
    const docsDirAbs = engineDir();
    const d = logDiff({ root: gitRootFor(docsDirAbs), refA: a, refB: b, docsDirAbs }); // ADR-0003: workspace's own repo
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
    const docsDirAbs = engineDir(), root = gitRootFor(docsDirAbs); // ADR-0003: workspace's own repo
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

// impact: pre-change blast radius — which pages (transitively) rest on this one, so you can see the
// cost before you touch its claim. Reverse rests_on closure; cycle-safe (each node at most once).
function runImpact() {
  try {
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if (!title) die('usage: gazette impact "<page title>"');
    const docsDir = engineDir();
    const { node, model } = resolvePage(docsDir, title);
    const { affected } = blastRadius(model, node.uid);
    const titleOf = new Map(Object.values(model.nodes).map((n) => [n.uid, n.title]));
    if (!affected.length) { console.log("impact of [" + node.title + "]: nothing rests on it — safe to change"); return; }
    console.log("impact of [" + node.title + "]: " + affected.length + " page(s) rest on it (transitively) — review after changing its claim:");
    for (const uid of affected) console.log("  · " + (titleOf.get(uid) || uid));
  } catch (e) { die(e.message); }
}

// gate: print the eager dirty index + cutoff ratio BESIDE edge count (never alone).
function runGate() {
  try {
    const docsDir = engineDir();
    const model = buildModel({ corpus: loadCorpus({ docsDir }) });
    const pol = loadPolicy(docsDir);
    const g = computeGate({ model, events: readLog(logPath(docsDir)), policy: pol });
    const c = g.counts;
    console.log("gate: " + c.tracked + " tracked edges · " + g.dirty.length + " dirty pages · cutoff ratio " +
      (g.cutoffRatio == null ? "n/a" : (g.cutoffRatio * 100).toFixed(1) + "%") + " · " + c.untracked + " untracked · " + c.broken + " broken");
    // a cutoff means "confirmed by an ACCEPTED authority" — print which those are, so `current`
    // is never silently ambiguous between human-confirmed and machine-confirmed.
    console.log("  confirm-edge authorities: [" + pol["confirm-edge"].join(",") + "]");
    for (const d of g.dirty) console.log("  " + (d.freshness === "stale" ? "✗ stale       " : "· needs-review") + " " + d.uid);
    process.exit(0); // the gate is informational; broken/dirty is expected mid-work
  } catch (e) { die(e.message); }
}

// fsck: rebuild the mechanical-derived tier to a byte-fixpoint. Non-zero on a broken fixpoint OR any
// BLOCKING finding (unbacked-canonical, orphan-confirm, ledger-malformed); pending-scan is advisory.
function runFsck() {
  try {
    const docsDir = engineDir();
    // `--materialize-pages` refreshes the derived `effective_status:` cache in source pages (ADR-0004
    // Decision C). It requires write access, so it cannot combine with the read-only `--check`.
    const materializePages = argv.includes("--materialize-pages");
    if (materializePages && argv.includes("--check")) die("--materialize-pages writes source pages; it can't combine with --check (read-only)");
    const r = engineFsck({ docsDir, write: !argv.includes("--check"), materializePages });
    console.log("fsck: " + r.nodeCount + " pages · fixpoint " + (r.fixpointStable ? "stable ✅" : "UNSTABLE ✗") + " · digest " + r.digest.slice(0, 12) + " · " + r.findings.length + " finding(s)" + (materializePages ? " · effective_status materialized on " + r.materialized + " page(s)" : ""));
    for (const f of r.findings) console.log("  " + (r.blockingFindings.includes(f) ? "✗" : "·") + " " + f.kind + (f.uid ? " " + f.uid : "") + (f.detail ? " — " + f.detail : "") + (f.count ? " ×" + f.count : ""));
    process.exit(r.ok ? 0 : 1); // r.ok = fixpoint stable AND no blocking findings
  } catch (e) { die(e.message); } // a tampered log throws here → non-zero
}

// review: the ordered, typed review queue (ADR-0005 Decision A). Read-only — surfaces WHAT to review
// next, in dependency order (upstream-first), and the action that clears each item. `--next N` shows the
// first N; a resolve-conflict component is ONE atomic item and is never split. Exits 0 — a queue is a
// to-do list, not a pass/fail gate.
function runReview() {
  try {
    const docsDir = engineDir();
    const q = reviewQueue({ docsDir });
    const total = q.items.length;
    let items = q.items;
    const nextRaw = opt("next");
    if (nextRaw != null) {
      const n = parseInt(nextRaw, 10);
      if (!Number.isInteger(n) || n <= 0 || String(n) !== String(nextRaw).trim()) die("--next needs a positive integer");
      items = items.slice(0, n); // each item (incl. a conflict component) is atomic → never split
    }
    // machine-readable queue — approve/reapprove items carry a `digest` so you can seed a `--from`
    // manifest: `gazette review --json > decisions.json`, keep what you vetted, add reject reasons.
    // Emitted AFTER --next is validated/applied, so `--json --next N` yields a consistent sliced set.
    if (argv.includes("--json")) {
      const counts = {}; for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
      process.stdout.write(JSON.stringify({ items, counts, total }, null, 2) + "\n");
      return;
    }
    const summary = Object.entries(q.counts).map(([k, c]) => c + " " + k).join(" · ") || "nothing";
    console.log("review queue: " + total + " item(s) — " + summary);
    if (!total) { console.log("  ✅ nothing awaiting review"); return; }
    // Titles are UNTRUSTED (quotes, `$( )`, ANSI control chars) and these lines are printed to a terminal
    // and meant to be copied into a shell — strip control chars (terminal-injection) then POSIX
    // single-quote (shell-injection) every interpolated title.
    const shq = (s) => "'" + stripControl(String(s == null ? "" : s)).replace(/'/g, "'\\''") + "'";
    const disp = (t) => (t == null ? "(untitled)" : stripControl(String(t)));
    const action = {
      approve: (it) => "gazette approve " + shq(it.titles[0]) + " --by human",
      reapprove: (it) => "gazette approve " + shq(it.titles[0]) + " --by human   (rebinds the edited bytes)",
      "confirm-dependencies": (it) => "gazette confirm " + shq(it.titles[0]) + " --by human",
      // a component of >2 pages is resolved pair-by-pair (`resolve` takes exactly two) — one command each.
      "resolve-conflict": (it) => (it.pairs && it.pairs.length ? it.pairs : [it.titles.slice(0, 2)])
        .map((p) => "gazette resolve " + shq(p[0]) + " " + shq(p[1]) + " --winner … --by human").join("\n      → "),
      "repair-edge": () => "edit the page — its rests_on names a missing target/span",
    };
    items.forEach((it, i) => {
      const who = it.titles.map(disp).join(" × ");
      console.log("  " + (i + 1) + ". [" + it.kind + "] " + who);
      console.log("      why: " + it.why);
      console.log("      → " + action[it.kind](it));
    });
    if (nextRaw != null && items.length < total) console.log("  … " + (total - items.length) + " more (drop --next to see all)");
  } catch (e) { die(e.message); }
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

// telemetry: convergence telemetry — a deterministic replay of the decision log (§4.14). Is the canon
// converging (queue drains between edit bursts, repeated firings trend to zero) or thrashing? Purely
// informational: convergence state is a signal to read, not a pass/fail gate, so it always exits 0.
function runTelemetry() {
  try {
    const docsDir = engineDir();
    const model = buildModel({ corpus: loadCorpus({ docsDir }) });
    const t = projectTimeline({ model, events: readLog(logPath(docsDir)), policy: loadPolicy(docsDir) });
    const titleOf = new Map(Object.values(model.nodes).map((n) => [n.uid, n.title]));
    console.log(renderTimelineText(t, { titleOf }));
    process.exit(0);
  } catch (e) { die(e.message); }
}

// resolve a page TITLE to its opaque uid + node (the decision-event verbs address pages by title).
function resolvePage(docsDir, title) {
  const corpus = loadCorpus({ docsDir });
  const model = buildModel({ corpus });
  const node = model.nodes[nfc(String(title))];
  if (!node) die('no page titled [' + title + ']');
  return { model, node, corpus };
}

// decision-event API (ADR-0001, Schema 1) — the human/review side of the log. In 0.8 the review
// skill drives these; in 0.7 they are the CLI surface that gives the gate a real event stream.
// A decision must NAME its authority — never a silent `by: "human"` (ADR-0004). Requiring `--by`
// removes the footgun where an AI/automation running `gazette approve "x"` records a human authority
// it does not hold; the human runs it themselves (`--by <name>`), or a pipeline names its machine
// authority (`--by invariant`). BUREAU.md forbids the AI asserting `--by human`.
function requireBy(cmd) {
  const by = opt("by");
  if (!by || !String(by).trim()) die(cmd + " requires --by <authority> (e.g. `--by human` when you are the reviewer, or `--by invariant` for an automated gate) — a decision is never silently 'human'.");
  return by;
}

// Validate a decisions manifest WHOLE before any write (ADR-0005 Decision B): every page resolves, every
// approve carries a `digest` that matches the current reviewed bytes (a bare title is refused — a batch
// approval must pin bytes), every reject carries a `because`, and no page appears twice or in both
// lists. Any failure → die with the full list; zero events written.
function validateManifest(docsDir, manifest) {
  const observedSeq = logHead(docsDir); // the log head these decisions are validated against (CAS baseline)
  const corpus = loadCorpus({ docsDir });
  const model = buildModel({ corpus });
  // project the CURRENT decisions so a manifest reject can be required to target — and scoped to — an
  // active approval, instead of silently logging an inert reject the CLI would still report as "rejected".
  let decisions = null; try { decisions = projectDecisions(readLog(logPath(docsDir)), loadPolicy(docsDir)); } catch { decisions = null; }
  const rawByUid = new Map((corpus.entries || []).map((e) => [e.uid, e.raw]));
  const byTitle = (t) => model.nodes[nfc(String(t))];
  // a PRESENT-but-non-array half (including `null`) must be rejected, not silently dropped (which would
  // commit the valid half) — test presence with hasOwnProperty so `"approve": null` is caught too.
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(manifest, k);
  if (hasKey("approve") && !Array.isArray(manifest.approve)) die("manifest `approve` must be an array");
  if (hasKey("reject") && !Array.isArray(manifest.reject)) die("manifest `reject` must be an array");
  const approveIn = Array.isArray(manifest.approve) ? manifest.approve : [];
  const rejectIn = Array.isArray(manifest.reject) ? manifest.reject : [];
  const seen = new Set(), approvals = [], rejections = [], problems = [];
  for (const e of approveIn) {
    const t = typeof e === "string" ? e : (e && e.page);
    if (!t) { problems.push("an approve entry has no page title"); continue; }
    const n = byTitle(t);
    if (!n) { problems.push("approve: no page titled [" + t + "]"); continue; }
    if (seen.has(n.uid)) { problems.push("page listed twice / in both lists: " + t); continue; }
    seen.add(n.uid);
    const provided = (e && typeof e === "object") ? e.digest : null;
    let current; try { const raw = rawByUid.get(n.uid); current = raw != null ? reviewDigest({ raw, uid: n.uid, title: n.title }) : null; } catch { current = null; }
    if (current == null) { problems.push("approve: [" + t + "] cannot be content-bound (undigestible)"); continue; }
    if (!provided) { problems.push('approve: [' + t + '] needs a "digest" — a batch approval must pin the reviewed bytes'); continue; }
    if (provided !== current) { problems.push("approve: [" + t + "] digest mismatch — the page changed since it was reviewed"); continue; }
    approvals.push({ uid: n.uid, title: n.title, hash: current });
  }
  for (const e of rejectIn) {
    const t = e && e.page;
    if (!t) { problems.push("a reject entry has no page"); continue; }
    const n = byTitle(t);
    if (!n) { problems.push("reject: no page titled [" + t + "]"); continue; }
    if (seen.has(n.uid)) { problems.push("page listed twice / in both lists: " + t); continue; }
    seen.add(n.uid);
    if (!e.because || !String(e.because).trim()) { problems.push('reject: [' + t + '] needs a "because" reason'); continue; }
    if (e.approval_seq != null && !(Number.isInteger(e.approval_seq) && e.approval_seq > 0)) { problems.push("reject: [" + t + "] approval_seq must be a positive integer"); continue; }
    if (e.approval_hash != null && !(typeof e.approval_hash === "string" && e.approval_hash.length > 0)) { problems.push("reject: [" + t + "] approval_hash must be a non-empty string"); continue; }
    // a manifest reject REVOKES an active approval — require the page to BE approved, and scope the reject
    // to that exact approval (auto-populate seq+hash; verify any provided values match), so a reject can
    // never be reported successful while projecting to nothing.
    if (!decisions || !decisions.approved.has(n.uid)) { problems.push("reject: [" + t + "] is not currently approved — nothing to revoke (a proposed page needs no reject)"); continue; }
    const activeSeq = decisions.approvedSeq.get(n.uid) ?? null, activeHash = decisions.approvedHash.get(n.uid) ?? null;
    if (e.approval_seq != null && e.approval_seq !== activeSeq) { problems.push("reject: [" + t + "] approval_seq " + e.approval_seq + " does not match the active approval (" + activeSeq + ") — re-review"); continue; }
    if (e.approval_hash != null && e.approval_hash !== activeHash) { problems.push("reject: [" + t + "] approval_hash does not match the active approval — re-review"); continue; }
    rejections.push({ uid: n.uid, because: String(e.because).trim(), approval_seq: activeSeq, approval_hash: activeHash });
  }
  if (!approvals.length && !rejections.length) problems.push("the manifest has no decisions");
  if (problems.length) die("manifest rejected — NO events written:\n  - " + problems.join("\n  - "));
  return { approvals, rejections, observedSeq };
}

// Apply a validated batch as ONE commit-gated transaction (ADR-0005 Decision B): batch-begin → N
// content-bound approves / scoped rejects (each stamped with the batch_id, so the log reveals the bulk)
// → batch-commit, all under one appendBatch lock. A crash before commit leaves an uncommitted prefix the
// projection ignores. Shared by `approve --from` and `approve --all`.
function logHead(docsDir) { try { const evs = readLog(logPath(docsDir)); return evs.length ? evs[evs.length - 1].seq : 0; } catch { return null; } }

function applyBatch(docsDir, { approvals, rejections, mode, by, expectedSeq = null }) {
  const n = approvals.length + rejections.length;
  // refuse an unauthorized batch UP FRONT rather than committing an inert one the CLI would still report
  // as applied — dangerous for a reject, whose target approval would silently stand. (Revocation reuses
  // the approve authority, ADR-0004.)
  const pol = loadPolicy(docsDir);
  if (!isAuthorized(pol, "approve", authorityClass(by))) die("`--by " + by + "` is not an accepted approve authority for this workspace (policy: " + (pol.approve || []).join(", ") + ") — refusing; the batch would commit nothing.");
  const manifestDigest = "bureau-manifest-v1:" + createHash("sha256")
    .update(JSON.stringify({ mode, by, approve: approvals.map((a) => [a.uid, a.hash]), reject: rejections.map((r) => [r.uid, r.because, r.approval_seq ?? null, r.approval_hash ?? null]) }))
    .digest("hex");
  // FRESH random id per attempt — keeps crash-recovery clean: a batch that crashed mid-append leaves
  // an uncommitted (inert) bracket, and a rerun writes a brand-new bracket that commits cleanly, with
  // no id reuse to trip the total-count tombstone. A full rerun of an already-committed APPROVAL
  // manifest just re-appends a harmless duplicate (re-approving pins the same digest; rejects are
  // auto-scoped at reject time, so the changed active seq breaks nothing); a rerun that includes a
  // reject is refused earlier by validateManifest. A content-addressed id was tried and reverted.
  const batchId = "batch-" + randomBytes(8).toString("hex");
  const events = [
    { type: "batch-begin", batch_id: batchId, mode, n, manifest_digest: manifestDigest, by },
    ...approvals.map((a) => ({ type: "approve", id: a.uid, to_trust: "canonical", by, hash: a.hash, batch_id: batchId })),
    ...rejections.map((r) => { const ev = { type: "reject", id: r.uid, by, reason: r.because, batch_id: batchId }; if (r.approval_seq != null) ev.approval_seq = r.approval_seq; if (r.approval_hash != null) ev.approval_hash = r.approval_hash; return ev; }),
    { type: "batch-commit", batch_id: batchId },
  ];
  const stored = appendBatch(logPath(docsDir), (current) => {
    // compare-and-swap: refuse if another writer moved the log head since these decisions were validated,
    // so a stale batch can't silently supersede a concurrent approve/reject.
    const head = current.length ? current[current.length - 1].seq : 0;
    if (expectedSeq != null && head !== expectedSeq) { const e = new Error("the decision log changed since these decisions were prepared (head " + expectedSeq + " → " + head + ") — re-run against the current state"); e.code = "ECASFAIL"; throw e; }
    return events;
  });
  return { batchId, manifestDigest, n, seq: stored[stored.length - 1].seq };
}

function runApproveFrom(fromFile) {
  const docsDir = engineDir();
  const by = requireBy("gazette approve --from");
  let manifest;
  try { manifest = JSON.parse(readFileSync(resolve(process.cwd(), fromFile), "utf8")); }
  catch (e) { die("could not read/parse manifest " + fromFile + ": " + e.message); }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) die("manifest must be a JSON object with `approve` / `reject` arrays");
  const { approvals, rejections, observedSeq } = validateManifest(docsDir, manifest);
  const r = applyBatch(docsDir, { approvals, rejections, mode: "from", by, expectedSeq: observedSeq });
  console.log("✓ batch " + r.batchId + " committed — " + approvals.length + " approved, " + rejections.length + " rejected (log seq " + r.seq + ")");
  console.log("  note: `canonical` is a projection of these events; `gazette review` shows what remains, `gazette fsck --materialize-pages` refreshes effective_status.");
}

// Read one line from stdin synchronously (the CLI dispatch is sync). EOF (Ctrl-D) or an empty line reads
// as "no" — the safe default for the bulk-approve confirmation.
function readLineSync() {
  const buf = Buffer.alloc(1); let s = "";
  for (;;) {
    let n; try { n = readSync(0, buf, 0, 1, null); } catch (e) { if (e.code === "EAGAIN") continue; break; }
    if (n === 0) break;
    const ch = buf.toString("utf8"); if (ch === "\n") break; if (ch !== "\r") s += ch;
  }
  return s;
}
function confirmYesNo(prompt) { process.stdout.write(prompt); const a = readLineSync().trim().toLowerCase(); return a === "y" || a === "yes"; }

// approve --all (ADR-0005 Decision C): bulk-approve the *approvable* backlog. Warn-and-go, but honest —
// capture each digest BEFORE the warning (no unseen bytes), condition the warning on the authority,
// refuse (never hashless) an undigestible page, and stamp a batch_id so the log reveals the bulk. TTY:
// interactive confirm. Non-TTY: warn to stderr and proceed (no --yes gate) — an owner-accepted weakening.
function runApproveAll() {
  const docsDir = engineDir();
  const by = requireBy("gazette approve --all");
  const observedSeq = logHead(docsDir); // CAS baseline — refuse at apply time if the log moved meanwhile
  const q = reviewQueue({ docsDir });
  const approvable = q.items.filter((it) => it.kind === "approve" || it.kind === "reapprove");
  const excluded = q.items.filter((it) => it.kind !== "approve" && it.kind !== "reapprove");
  if (!approvable.length) {
    console.log("nothing to bulk-approve — 0 approve/reapprove items." + (excluded.length ? " " + excluded.length + " item(s) need resolve/confirm/repair (see `gazette review`)." : ""));
    return;
  }
  // capture each page's digest FIRST — content-bind to the bytes we are about to show, not to whatever
  // they become during the prompt. Refuse the whole run if any page can't be content-bound (never hashless).
  const corpus = loadCorpus({ docsDir });
  const rawByUid = new Map((corpus.entries || []).map((e) => [e.uid, e.raw]));
  const captured = [], undigestible = [];
  for (const it of approvable) {
    const uid = it.uids[0], title = it.titles[0];
    let hash; try { const raw = rawByUid.get(uid); hash = raw != null ? reviewDigest({ raw, uid, title }) : null; } catch { hash = null; }
    if (hash == null) undigestible.push(title || uid); else captured.push({ uid, title, hash, kind: it.kind });
  }
  const clean = (s) => stripControl(String(s == null ? "" : s)); // titles are untrusted — strip terminal-control chars before printing
  if (undigestible.length) die("refusing --all: cannot content-bind " + undigestible.length + " page(s) — " + undigestible.map(clean).join(", ") + ". Approve them individually.");
  // honest warning, conditioned on the actual authority; each page shows its kind (approve vs reapprove)
  const warn = (s) => process.stderr.write(s + "\n");
  warn("⚠ BULK APPROVE — " + captured.length + " page(s):");
  for (const c of captured) warn("    • [" + c.kind + "] " + clean(c.title || c.uid));
  if (excluded.length) warn("  (excluded — need resolve/confirm/repair, NOT approve: " + excluded.map((e) => e.titles.map(clean).join(" × ")).join(", ") + ")");
  warn(authorityClass(by) === "human"
    ? "  This asserts a HUMAN read and vouched for EACH of these " + captured.length + " claims as canonical (`by` is a claim, not authentication — BUREAU.md)."
    : "  Recorded under `" + by + "` — a cooperating-pipeline authority, NOT a human vouch.");
  warn("  Each is content-bound to its current bytes and recorded as one bulk batch (batch_id).");
  if (process.stdin.isTTY && process.stdout.isTTY) {
    if (!confirmYesNo("Approve all " + captured.length + " page(s)? [y/N] ")) { console.log("aborted — no events written."); return; }
  } else warn("  (non-interactive — proceeding without a prompt; a human at a keyboard would be asked to confirm)");
  // TOCTOU guard: a page edited since capture no longer matches → refuse it, never approve unseen bytes
  const fresh = loadCorpus({ docsDir });
  const freshRaw = new Map((fresh.entries || []).map((e) => [e.uid, e.raw]));
  const drifted = [];
  for (const c of captured) { let now; try { const raw = freshRaw.get(c.uid); now = raw != null ? reviewDigest({ raw, uid: c.uid, title: c.title }) : null; } catch { now = null; } if (now !== c.hash) drifted.push(c.title || c.uid); }
  if (drifted.length) die("refusing --all: " + drifted.length + " page(s) changed since the warning — " + drifted.map(clean).join(", ") + ". Re-run to review the new bytes.");
  // re-verify each captured page is STILL a plain approval — during the prompt an upstream span change can
  // turn a page into repair-edge/confirm-dependencies WITHOUT changing its own bytes (so the digest matched).
  let freshApprovable;
  try { freshApprovable = new Set(); for (const it of reviewQueue({ docsDir }).items) if (it.kind === "approve" || it.kind === "reapprove") for (const u of it.uids) freshApprovable.add(u); }
  catch { die("refusing --all: could not re-verify the review queue after the prompt — re-run `gazette review`."); } // FAIL CLOSED
  const gone = captured.filter((c) => !freshApprovable.has(c.uid)).map((c) => stripControl(String(c.title || c.uid)));
  if (gone.length) die("refusing --all: " + gone.length + " page(s) are no longer plain approvals (a dependency or conflict changed) — " + gone.join(", ") + ". Re-run `gazette review`.");
  const r = applyBatch(docsDir, { approvals: captured, rejections: [], mode: "all", by, expectedSeq: observedSeq });
  console.log("✓ batch " + r.batchId + " committed — " + captured.length + " approved (log seq " + r.seq + "). `canonical` is a projection; run `gazette review` to see what remains.");
}

function runApprove() {
  try {
    const fromFile = opt("from");
    const wantsAll = argv.includes("--all");
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if ([fromFile != null, wantsAll, title != null].filter(Boolean).length > 1) die("approve takes ONE of: a page title · --from <manifest.json> · --all");
    if (wantsAll) return runApproveAll();
    if (fromFile != null) return runApproveFrom(fromFile);
    if (!title) die('usage: gazette approve "<title>" --by <auth>  |  --from <manifest.json>  |  --all --by <auth>');
    const by = requireBy("gazette approve");
    const docsDir = engineDir();
    const { node, corpus } = resolvePage(docsDir, title);
    // content-bind the approval (ADR-0004): pin the reviewed page digest, computed the SAME way fsck
    // recomputes it, so an edit after approval surfaces as `stale-approval` instead of silent canon.
    const entry = corpus.entries.find((e) => e.uid === node.uid);
    let hash; try { if (entry) hash = reviewDigest({ raw: entry.raw, uid: node.uid, title: node.title }); } catch { hash = undefined; }
    const ev = appendEvent(logPath(docsDir), hash ? { type: "approve", id: node.uid, to_trust: "canonical", by, hash } : { type: "approve", id: node.uid, to_trust: "canonical", by });
    console.log("✓ approved [" + node.title + "] → trust: canonical (backed by log seq " + ev.seq + (hash ? ", content-bound" : "") + ")");
    // the page file is NOT rewritten (ADR-0004 Decision C) — canonical is a projection of this event.
    console.log("  note: frontmatter still reads its authored `status:` — `canonical` is a PROJECTION of this");
    console.log("        event. See the `effective_status:` key (refresh: gazette fsck --materialize-pages).");
  } catch (e) { die(e.message); }
}
function runReject() {
  try {
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if (!title) die('usage: gazette reject "<page title>" --by <authority> [--reason "…"]');
    const by = requireBy("gazette reject");
    const docsDir = engineDir();
    const { node } = resolvePage(docsDir, title);
    // revocation reuses the approve authority (ADR-0004): a reject the policy rejects is inert, so the
    // human approval stands. Naming `by` is what lets the projection gate it.
    appendEvent(logPath(docsDir), { type: "reject", id: node.uid, by, reason: opt("reason", "") });
    console.log("✓ rejected [" + node.title + "] (logged; if unauthorized it is inert and any prior approval stands)");
  } catch (e) { die(e.message); }
}
// confirm every currently-open tracked edge OF a dependent page (the human vouches the edge holds).
function runConfirm() {
  try {
    const title = argv[1] && !argv[1].startsWith("--") ? argv[1] : opt("page");
    if (!title) die('usage: gazette confirm "<dependent page title>" --by <authority>');
    const by = requireBy("gazette confirm");
    const docsDir = engineDir();
    const { node, model } = resolvePage(docsDir, title);
    const g = computeGate({ model, events: readLog(logPath(docsDir)), policy: loadPolicy(docsDir) });
    let n = 0, skippedBroken = 0;
    for (const e of g.edges) {
      if (!e.tracked || !e.open || e.dep !== node.uid) continue;
      // never confirm a BROKEN edge (missing target / missing span) — it has no valid verdict key to
      // vouch for; confirming it would append a bogus/empty confirmation and falsely report success.
      if (e.broken || !e.edgeId || !e.verdictKey) { skippedBroken++; continue; }
      appendEvent(logPath(docsDir), { type: "confirm-edge", edge: e.edgeId, verdict_key: e.verdictKey, by });
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
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) die('usage: gazette resolve "<page A>" "<page B>" --winner "<title>" --by <authority>');
    const by = requireBy("gazette resolve");
    const docsDir = engineDir();
    const model = buildModel({ corpus: loadCorpus({ docsDir }) });
    const na = model.nodes[nfc(String(a))], nb = model.nodes[nfc(String(b))];
    if (!na) die("no page titled [" + a + "]");
    if (!nb) die("no page titled [" + b + "]");
    const winner = opt("winner");
    if (!winner) die('resolve needs --winner "<title>"');
    const wn = model.nodes[nfc(String(winner))];
    if (!wn || (wn.uid !== na.uid && wn.uid !== nb.uid)) die("--winner must be one of the two named pages");
    // The pair must ACTUALLY contradict each other right now. Without this, a resolution could be
    // pre-seeded for any two pages, and if a `contradicts:` edge appeared between them later the
    // stale event resolved it automatically — a conflict that never faced review.
    const contradicts = model.edges.some((e) => e.edgeType === "contradicts" &&
      ((e.sourceUid === na.uid && model.nodes[e.target] && model.nodes[e.target].uid === nb.uid) ||
       (e.sourceUid === nb.uid && model.nodes[e.target] && model.nodes[e.target].uid === na.uid)));
    if (!contradicts) die("[" + na.title + "] and [" + nb.title + "] do not declare a `contradicts:` edge — there is no conflict to resolve");
    // record the resolving authority like approve/confirm do — without a `by`, every resolution
    // classified as `human` by default and the `resolve` policy had nothing to gate on.
    const ev = appendEvent(logPath(docsDir), { type: "resolve", conflict: conflictKey(na.uid, nb.uid), winner: wn.uid, by });
    console.log("✓ resolved [" + na.title + "] × [" + nb.title + "] → winner [" + wn.title + "] (resolution_id " + ev.seq + ")");
  } catch (e) { die(e.message); }
}

// legacy-migrate (ADR-0004 Phase 6): grandfather EXISTING effective-canonical pages that aren't
// content-bound (an authored canonical with no approve, or an approve that predates content-binding)
// into the digest-pinned `_legacy-canonical.json` manifest. `legacy-canonical` is honestly WEAKER than
// `approved` and is NOT a forged approval; a content change voids the pin; a real approval supersedes
// it. The human runs this and commits/reviews the manifest (`--check` previews, writes nothing).
function runLegacyMigrate() {
  try {
    const check = argv.includes("--check");
    const docsDir = engineDir();
    const corpus = loadCorpus({ docsDir });
    const model = buildModel({ corpus });
    const events = readLog(logPath(docsDir));
    const policy = loadPolicy(docsDir);
    const rawByUid = new Map(corpus.entries.map((e) => [e.uid, e.raw]));
    const titleByUid = new Map(Object.values(model.nodes).map((n) => [n.uid, n.title]));
    const digestFor = (uid) => { const raw = rawByUid.get(uid), title = titleByUid.get(uid); try { return raw != null ? reviewDigest({ raw, uid, title }) : null; } catch { return null; } };
    const pins = legacyCandidates({ model, events, policy, digestFor });
    const uids = Object.keys(pins).sort();
    const lp = legacyPath(docsDir);
    if (check) {
      if (!uids.length) { console.log("legacy-migrate --check: nothing to grandfather — every canonical page is content-bound or already re-approved."); return; }
      console.log("legacy-migrate --check: " + uids.length + " page(s) WOULD be grandfathered as `legacy-canonical` (not review-backed; voided on any content change):");
      for (const uid of uids) console.log("  · " + (titleByUid.get(uid) || uid) + "  [" + uid + "]");
      console.log("Run without --check to write " + LEGACY_BASENAME + " (then commit + review it), or re-approve each with `gazette approve \"<title>\" --by human` for a real content-bound approval.");
      return;
    }
    if (existsSync(lp) && lstatSync(lp).isSymbolicLink()) die(LEGACY_BASENAME + " is a symlink (refused): " + lp);
    if (!uids.length) {
      if (existsSync(lp)) { rmSync(lp); console.log("✓ legacy-migrate: nothing to grandfather — removed the now-empty " + LEGACY_BASENAME + "."); }
      else console.log("legacy-migrate: nothing to grandfather.");
      return;
    }
    const manifest = { schema: 1,
      note: "Grandfathered legacy-canonical pins (ADR-0004 Phase 6). Each entry is an EXISTING effective-canonical page pinned to the digest of its CURRENT content. This is NOT a review approval — `canonical` here does not imply a human vouched; a meaningful content change voids the pin; a real content-bound approval supersedes and removes it. Generated by `gazette legacy-migrate`, committed and reviewed by a human.",
      pins: {} };
    for (const uid of uids) manifest.pins[uid] = pins[uid];
    writeFileSync(lp, JSON.stringify(manifest, null, 2) + "\n");
    console.log("✓ legacy-migrate: grandfathered " + uids.length + " page(s) → " + LEGACY_BASENAME + " (review + commit it):");
    for (const uid of uids) console.log("  · " + (titleByUid.get(uid) || uid));
    console.log("They now read `legacy-canonical` (advisory) instead of unbacked/unbound. Re-approve any (`gazette approve … --by human`) for a real content-bound approval.");
  } catch (e) { die(e.message); }
}

// ledger: the mechanical trust ledgers, callable by the compile/review skills.
// Positional args to a `ledger` subcommand (the session ids), skipping value-consuming flags — the old
// `argv.slice(2).filter(a => !a.startsWith("--"))` left a flag's VALUE behind (e.g. `--dir <path>` leaked
// the path in as a fake session id).
const LEDGER_VALUE_FLAGS = new Set(["--dir", "--docs", "--data", "--now", "--out", "--page", "--artifact", "--claim"]);
function ledgerPositionals() {
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (LEDGER_VALUE_FLAGS.has(a) && a.indexOf("=") < 0) i++; continue; }
    out.push(a);
  }
  return out;
}
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
      const ids = ledgerPositionals();
      if (!ids.length) die("usage: gazette ledger mark-compiled <session-id> [<session-id>...]");
      // validate against the logbook — a non-session id (e.g. a stray "canon") must never enter the ledger
      const known = new Set(logbookSessionIds(docsDir));
      const unknown = ids.filter((id) => !known.has(String(id)));
      if (unknown.length) die("no logbook session matches: " + unknown.join(", ") + " — give a `session:` id that exists under logbook/ (see `gazette ledger uncompiled`).");
      console.log("✓ marked " + markCompiled(docsDir, ids) + " new session(s) compiled");
    } else if (action === "uncompiled") {
      const ids = ledgerPositionals();
      // no ids → compare against EVERY logbook session, so bare `uncompiled` reports the real backlog
      // (it used to print "(all compiled)" for an empty list, which read as an answer, not as "no input").
      const all = ids.length ? ids : logbookSessionIds(docsDir);
      if (!all.length) { console.log(ids.length ? "(all compiled)" : "no sessions found under logbook/"); return; }
      const out = uncompiled(docsDir, all);
      console.log(out.length ? out.join("\n") : "(all " + all.length + " logbook session(s) compiled)");
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
  case "impact": runImpact(); break;
  case "fsck": runFsck(); break;
  case "review": runReview(); break;
  case "report": runReport(); break;
  case "telemetry": runTelemetry(); break;
  case "ledger": runLedger(); break;
  case "legacy-migrate": runLegacyMigrate(); break;
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
      '  gazette impact "<title>"           pre-change blast radius: which pages rest on this one',
      "  gazette fsck [--check]             rebuild mechanical-derived state to a byte-fixpoint (CI gate)",
      "  gazette report                     deterministic auditable metrics (kill rate, fixpoint, cutoff)",
      "  gazette telemetry                  convergence telemetry: is the canon converging or thrashing? (§4.14)",
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
      "  common flags: --dir <dir> (content dir; auto-detects a bureau workspace via */bureau.json, else gazette/)  --data <dir>  --out <dir>  --now YYYY-MM-DD",
    ].join("\n"));
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
