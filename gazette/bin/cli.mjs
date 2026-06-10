#!/usr/bin/env node
// gazette — offline knowledge-base board: gazette/*.html → self-contained static site.
//   gazette init                  scaffold docs/_config.json + a sample in the current dir
//   gazette build [opts]          build dist/
//   gazette serve [--port 8080]   build, then serve dist/ locally
// opts: --docs <dir>(=docs)  --data <dir>(=data)  --out <dir>(=dist)
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, lstatSync, readdirSync, realpathSync, watch } from "fs";
import { join, resolve, dirname, extname, sep, relative } from "path";
import { createServer } from "http";
import { spawn } from "child_process";
import { buildSite, computeHealth } from "../src/build.mjs";
import { renderHealthText } from "../src/core/health-report.mjs";
import { healthTotal } from "../src/derive/health.mjs";
import { parseDate } from "../src/services/dates.mjs";
import { planRename, applyRename } from "../src/maintain/rename.mjs";
import { buildRepairPlan, applySafe, renderRepairText } from "../src/maintain/doctor.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function opt(name, def) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : def; // a following flag is not this option's value (grill L6)
}

// today's date (YYYY-MM-DD) as the default staleness baseline; --now overrides.
function today() {
  return new Date().toISOString().slice(0, 10);
}

function die(msg) { console.error("✗ " + msg); process.exit(1); }

// content dir: --dir (or legacy --docs); engine defaults to "gazette" when omitted
function dirArg() { return opt("dir") || opt("docs"); }
function dataArg() { return opt("data"); }
const prettifyCli = (s) => String(s).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// validated staleness baseline — a bad --now must fail loud, never silently disable
// staleness and exit green (grill H6).
function nowArg() {
  const v = opt("now", today());
  if (!parseDate(v).valid) die('--now must be a valid YYYY-MM-DD (got: "' + v + '")');
  return v;
}

function runBuild() {
  try {
    const r = buildSite({ docsDir: dirArg(), dataDir: dataArg(), outDir: opt("out"), now: nowArg() });
    const bits = [r.fileDocCount + " documents"];
    if (r.coldCount) bits.push("cold events " + r.coldCount + " → sequence diagrams + daily table");
    if (r.themeOverride) bits.push("theme.css override");
    if (r.assetsCopied) bits.push("assets/ copied");
    const h = r.health;
    const total = h.dangling + h.orphan + h.contradiction + h.invalidDate + h.stale + h.schema + h.drift;
    bits.push("health " + (r.healthClean ? "✅" : "⚠ " + total + (total === 1 ? " item" : " items")));
    console.log("✓ build: " + bits.join(", ") + " (" + r.totalDocs + " pages) -> " + r.outDir);
    return r;
  } catch (e) {
    die(e.message);
  }
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
  const now = nowArg();
  const build = () => {
    try {
      const r = buildSite({ root, docsDir, dataDir, outDir: opt("out"), now, force: true });
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
  const title = titleArg || prettifyCli(rel.split("/").pop().replace(/\.html$/, ""));
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, '<article data-updated="' + today() + '">\n  <h1>' + escText(title) + "</h1>\n  <p></p>\n</article>\n");
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
  try { spawn(opener, args, { stdio: "ignore", detached: true }).unref(); console.log("→ opened " + idx); }
  catch { console.log("open this in your browser: " + idx); }
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
  const now = nowArg();
  const out = resolve(root, opt("out") || "dist");
  const doBuild = () => { try { return buildSite({ root, docsDir, dataDir, outDir: opt("out"), now, force: true }); } catch (e) { console.error("✗ " + e.message); return null; } };
  if (!doBuild()) die("initial build failed — fix the error above and re-run");
  const outReal = realpathSync(out);
  const within = (q, base) => q === base || q.startsWith(base + sep);
  const clients = new Set(); // open SSE responses

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/__wb_reload") { // SSE live-reload channel
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
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
      console.log("✓ rebuilt · " + r.totalDocs + " pages · health " + (r.healthClean ? "✅" : "⚠"));
      for (const c of clients) { try { c.write("data: reload\n\n"); } catch (_) { /* dropped */ } }
    }, 150);
  };
  if (existsSync(docsDir)) watchTree(docsDir, trigger);
  for (const f of ["theme.json", "theme.css"]) { const p = join(root, f); if (existsSync(p)) watch(p, trigger); }
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
      "  gazette audit  (alias: health)     deterministic check: dangling/orphan/contradiction/stale/schema/drift",
      "  gazette doctor [--apply]           audit → repair plan (--apply fixes the safe subset)",
      '  gazette rename "<old>" "<new>" [--dry]  rename a doc + propagate every reference',
      "",
      "  common flags: --dir <dir> (content dir, default gazette/)  --data <dir>  --out <dir>  --now YYYY-MM-DD",
    ].join("\n"));
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
