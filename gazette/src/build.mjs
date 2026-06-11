// build.mjs  -  gazette engine core: gazette/*.html (SSOT) -> self-contained dist/.
// single parse authority: loadCorpus read + validate once; model and board both project from one corpus (grill H3). 
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync, rmSync, renameSync, readdirSync, lstatSync, realpathSync } from "fs";
import { join, dirname, resolve, sep, relative } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { loadCorpus, buildModel, SCHEMA_VERSION } from "./core/model.mjs";
import { deriveBacklinks } from "./derive/backlinks.mjs";
import { deriveHealth, healthTotal } from "./derive/health.mjs";
import { deriveTimeline } from "./derive/timeline.mjs";
import { deriveLayout } from "./derive/layout.mjs";
import { renderGraphSvg } from "./render/graph-svg.mjs";
import { renderCanvasSvg } from "./render/canvas-svg.mjs";
import { deriveGit, renderTemporalHtml } from "./derive/git.mjs";
import { scanCode, codeModel } from "./code/scan.mjs";
import { renderTreemapSvg } from "./code/treemap.mjs";
import { renderHealthHtml } from "./render/health-report.mjs";
import { canonicalJSON } from "./services/determinism.mjs";
import { escapeHtml, cspMeta, sanitizeBody } from "./services/sanitize.mjs";
import { resolveLinks, parseHtmlDoc, markdownToHtml, addHeadingIds, resolveImageEmbeds, replaceOutsideRaw } from "./core/parse.mjs";
import { slugify } from "./shared/slug.mjs";
import { makeResolve } from "./runtime/pure.mjs";
import { resolveTokens, emitCssVars } from "./services/theme.mjs";
import { bundleReport } from "./services/assets.mjs";
import { nfc } from "./services/i18n.mjs";

const HEALTH_TITLE = "Health";
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, "..", "template");
const ENGINE_LIB = ["app.js", "mermaid.min.js", "echarts.min.js", "js-yaml.min.js", "papaparse.min.js"]; // theme.css generated, not copied

// Refuse to rmSync the project root, an ancestor of it, or a filesystem root (grill M1).
// resolve a path through its deepest EXISTING ancestor's realpath, so a symlink anywhere
// in the chain can't route the output past the lexical guards. Non-existent leaf segments
// are re-appended verbatim (nothing to dereference yet).
function physicalPath(p) {
  let anc = p, tail = [];
  while (!existsSync(anc)) { const parent = dirname(anc); if (parent === anc) return p; tail.unshift(anc.slice(parent.length + 1)); anc = parent; }
  return tail.length ? join(realpathSync(anc), ...tail) : realpathSync(anc);
}
function guardOutDir(root, outDir, docsDir, dataDir) {
  // append a single trailing separator without doubling it for the filesystem root,
  // so `/` (already ending in sep) is still recognized as an ancestor of everything.
  const withSep = (p) => (p.endsWith(sep) ? p : p + sep);
  // Compare PHYSICAL paths (realpath of the deepest existing ancestor) so a symlinked
  // output ancestor can't smuggle writes into the content/data tree or outside root.
  const rootP = physicalPath(root), docsP = docsDir && physicalPath(docsDir), dataP = dataDir && physicalPath(dataDir);
  // the dist swap also creates+removes these siblings — they must clear the same guards.
  const targets = [["--out", outDir], ["--out temp dir", outDir + ".tmp"], ["--out backup dir", outDir + ".bak"]];
  for (const [olabel, o] of targets) {
    const oP = physicalPath(o);
    if (oP === rootP || withSep(rootP).startsWith(withSep(oP))) {
      throw new Error("Refusing to build: " + olabel + " points at the project root or an ancestor (would recursively delete your workspace): " + o);
    }
    for (const [label, src] of [["content dir", docsP], ["data dir", dataP]]) {
      if (!src) continue;
      if (oP === src || withSep(oP).startsWith(withSep(src)) || withSep(src).startsWith(withSep(oP))) {
        throw new Error("Refusing to build: " + olabel + " (" + o + ") overlaps the " + label + " (" + src + ") — output would overwrite source content.");
      }
    }
  }
}

// build-time backlink index over every doc body (real + generated). Body links are
// [[..]] / data-wiki references (typed relations live on the root element, not the
// body, so they don't appear here — matching the old runtime panel). Each entry
// carries a plain-text context excerpt; the runtime escapes + renders it.
function buildBoardBacklinks(rawBodies, linksById) {
  const ids = Object.keys(rawBodies);
  const idSet = new Set(ids.map(nfc));
  const index = Object.create(null); // keyed by doc id — null proto (user titles may be "__proto__")
  for (const src of ids) {
    const links = [...new Set((linksById[src] || []).map(nfc))];
    for (const t of links) {
      if (t === src || !idSet.has(t)) continue; // self-links + dangling targets excluded
      (index[t] = index[t] || []).push({ source: src, excerpt: htmlExcerpt(rawBodies[src], t) });
    }
  }
  const out = Object.create(null);
  for (const t of Object.keys(index).sort()) { index[t].sort((a, b) => (a.source < b.source ? -1 : 1)); out[t] = index[t]; }
  return out;
}

// a short plain-text snippet of `html` around the first mention of `target`
function htmlExcerpt(html, target) {
  let text = String(html).replace(/<[^>]+>/g, " ")
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, a, b) => (b || a))
    .replace(/\s+/g, " ").trim();
  if (!text) return "";
  let i = text.indexOf(target); if (i < 0) i = 0;
  const start = Math.max(0, i - 30);
  let snip = text.slice(start, start + 90);
  if (start > 0) snip = "…" + snip;
  if (start + 90 < text.length) snip += "…";
  return snip;
}

// index image files under assets/ as {relpath, basename} → "assets/<relpath>" url
function buildAssetIndex(assetsDir) {
  const index = {};
  if (!existsSync(assetsDir)) return index;
  const baseCount = new Map(); // basename → how many distinct paths carry it
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name); let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue; // don't index links out of the assets tree
      const r = rel ? rel + "/" + name : name;
      if (st.isDirectory()) walk(p, r);
      else {
        const url = "assets/" + r; index[r] = url; // full relative path is always unambiguous
        baseCount.set(name, (baseCount.get(name) || 0) + 1);
        if (!(name in index)) index[name] = url;   // basename alias — pruned below if it collides
      }
    }
  };
  walk(assetsDir, "");
  // drop ambiguous basename aliases: a colliding `![[foo.png]]` must use the full path
  for (const [name, n] of baseCount) { if (n > 1 && name in index) delete index[name]; }
  return index;
}

// note transclusion: `![[Note]]` / `![[Note#Heading]]` → the target's content inline.
// One level (nested markers stripped → cycle-safe); missing targets render a marker.
const EMBED_BLOCK = /<p>\s*!\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]\s*<\/p>/g;
const EMBED_INLINE = /!\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g;
function sliceSection(html, slug) {
  const m = new RegExp('<h([1-6])[^>]*\\bid="' + slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>').exec(html);
  if (!m) return null;
  const lvl = +m[1], from = m.index;
  const nextRe = /<h([1-6])[^>]*>/g; nextRe.lastIndex = from + m[0].length;
  let nm, to = html.length;
  while ((nm = nextRe.exec(html))) { if (+nm[1] <= lvl) { to = nm.index; break; } }
  return html.slice(from, to);
}
// strip heading ids from transcluded content so the host doc keeps unique DOM ids
// (the original still owns the canonical id; the embed links to it via the caption).
const stripHeadingIds = (html) => String(html).replace(/(<h[1-6]\b[^>]*?)\s+id\s*=\s*("|')[\s\S]*?\2/gi, "$1");

// `source` is an immutable snapshot (id → rendered html) taken BEFORE any transclusion,
// so embedding is order-independent and self/cycle embeds can't pull in already-expanded
// content. Embed markers inside <pre>/<code> are left literal (replaceOutsideRaw).
function transcludeEmbeds(html, source) {
  const make = (rawTarget, rawHeading) => {
    const target = String(rawTarget).trim(), heading = (rawHeading || "").trim();
    const t = nfc(target), src = source[t];
    if (src == null) return '<div class="wb-embed-missing">⛔ missing embed: ' + escapeHtml(target + (heading ? "#" + heading : "")) + "</div>";
    let content = src;
    if (heading) { const sec = sliceSection(content, slugify(heading)); content = sec != null ? sec : '<p class="wb-embed-missing">⛔ no heading “' + escapeHtml(heading) + '”</p>'; }
    // one level — drop nested markers (outside code so literal ![[...]] examples survive) + dup ids
    content = stripHeadingIds(replaceOutsideRaw(content, (h) => h.replace(EMBED_INLINE, "")));
    const href = "#/" + encodeURIComponent(t) + (heading ? "?h=" + encodeURIComponent(slugify(heading)) : "");
    return '<figure class="wb-embed"><figcaption class="wb-embed-cap"><a href="' + href + '">' + escapeHtml(target + (heading ? " › " + heading : "")) + " ↗</a></figcaption><div class=\"wb-embed-body\">" + content + "</div></figure>";
  };
  return replaceOutsideRaw(html, (h) => h.replace(EMBED_BLOCK, (m, t, hd) => make(t, hd)).replace(EMBED_INLINE, (m, t, hd) => make(t, hd)));
}

// Hash of every build input (M2 incremental): content of docs/_types/data/assets +
// project theme + the engine bytes + schemaVersion + `now`. Same hash ⇒ same output
// (by determinism), so an unchanged rebuild is a safe no-op. A schemaVersion bump or
// an engine change invalidates the cache (closes the schemaVersion-invalidation gap).
function hashInputs({ root, docsDir, dataDir, now }) {
  const h = createHash("sha256");
  h.update("schema:" + SCHEMA_VERSION + "|now:" + (now || ""));
  for (const f of [...ENGINE_LIB, "theme.css"]) h.update(readFileSync(join(TEMPLATE_DIR, "lib", f)));
  h.update(readFileSync(join(TEMPLATE_DIR, "index.html")));
  const addDir = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      let st; try { st = lstatSync(p); } catch { continue; } // unreadable entry → skip, don't crash the build
      if (st.isSymbolicLink()) continue;                     // never follow links (cycles / external reads)
      if (st.isDirectory()) addDir(p);
      // key by path RELATIVE TO ROOT (not basename) so moving a same-named, same-bytes
      // file between subdirs invalidates the cache instead of colliding.
      else if (st.isFile()) { try { const buf = readFileSync(p); h.update("\0" + relative(root, p) + "\0"); h.update(buf); } catch { /* unreadable → skip */ } }
    }
  };
  addDir(docsDir);
  addDir(dataDir);
  addDir(join(root, "assets"));
  for (const f of ["theme.json", "theme.css"]) { const p = join(root, f); if (existsSync(p)) h.update(readFileSync(p)); }

  // out-of-docs/ sources must also invalidate the cache (else stale code/temporal views).
  // Skip a symlinked _config.json (matches model.mjs readConfig — never honor config that
  // points outside the content tree, e.g. to drive meta.code.dir hashing over arbitrary paths).
  let meta = {};
  try {
    const cfgPath = join(docsDir, "_config.json");
    if (!lstatSync(cfgPath).isSymbolicLink()) meta = JSON.parse(readFileSync(cfgPath, "utf8")).meta || {};
  } catch { /* missing/symlinked/invalid → hashed elsewhere */ }
  if (meta.code && meta.code.dir) {
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "vendor"]);
    // stat-based (size+mtime) — cheap on a large code tree, no content reads
    const statDir = (dir) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        if (SKIP.has(name) || name.startsWith(".")) continue;
        const p = join(dir, name);
        let st; try { st = lstatSync(p); } catch { continue; } // unreadable/removed → skip
        if (st.isSymbolicLink()) continue;                     // don't follow links (cycles / external trees)
        if (st.isDirectory()) statDir(p);
        else if (st.isFile()) h.update(p + ":" + st.size + ":" + st.mtimeMs);
      }
    };
    statDir(resolve(root, meta.code.dir));
  }
  if (meta.temporal && meta.temporal.enabled) {
    try { h.update("git:" + execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { /* not a repo */ }
  }
  return h.digest("hex");
}

// Shared model+health assembly used by both buildSite and `gazette health` (grill M10).
export function computeHealth({ docsDir, dataDir, now = null }) {
  dataDir = dataDir || join(docsDir, "_data"); // data lives under the content dir
  const corpus = loadCorpus({ docsDir, dataDir });
  const model = buildModel({ corpus });
  const backlinks = deriveBacklinks(model);
  const timeline = deriveTimeline(dataDir); // { docs, count } — generated, valid link targets
  const knownTargets = new Set(Object.keys(timeline.docs).map((t) => nfc(t)));
  const health = deriveHealth(model, backlinks, { now, knownTargets });
  return { corpus, model, backlinks, health, timeline };
}

export function buildSite({ root = process.cwd(), docsDir, dataDir, outDir, now = null, force = false } = {}) {
  root = resolve(root);
  docsDir = resolve(root, docsDir || "gazette");      // default content dir (was docs/)
  dataDir = resolve(root, dataDir || join(docsDir, "_data")); // data lives under the content dir
  outDir = resolve(root, outDir || "dist");
  guardOutDir(root, outDir, docsDir, dataDir);

  // incremental short-circuit (M2): identical inputs ⇒ the existing dist is current.
  const hash = hashInputs({ root, docsDir, dataDir, now });
  const metaPath = join(outDir, ".buildmeta.json");
  if (!force && existsSync(metaPath) && existsSync(join(outDir, "index.html"))) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      if (meta.hash === hash) return { ...meta.summary, outDir, cached: true };
    } catch { /* stale/corrupt meta → rebuild */ }
  }

  const { corpus, model, health, timeline } = computeHealth({ docsDir, dataDir, now });

  // ── board: project from corpus (same parse + NFC identity as the model)──
  // raw HTML bodies; wiki-link resolution + sanitization happen in one pass below.
  const docs = Object.create(null);      // keyed by user title — null proto blocks "__proto__" pollution
  const realLinks = Object.create(null); // id → body links the model already extracted (per-format, code-aware)
  for (const e of corpus.entries) {
    docs[e.id] = { group: e.group, icon: e.icon, meta: e.metaChips, body: e.body, format: e.format };
    realLinks[e.id] = e.bodyLinks;
  }
  const realTitles = new Set(Object.keys(docs));

  const groups = [...corpus.groups];

  // ── generated docs (Timeline / Health): throw on a title collision with a real doc (no silent overwrite)──
  const coldCount = timeline.count;
  if (Object.keys(timeline.docs).length) {
    for (const t of Object.keys(timeline.docs)) {
      if (realTitles.has(nfc(t))) throw new Error('generated-doc title collides with a real document: "' + t + '" - rename that real document');
    }
    for (const t of Object.keys(timeline.docs)) docs[nfc(t)] = timeline.docs[t];
    // auto-add the Timeline section (groups derive from folders now; generated docs
    // don't have a folder, so the engine owns their nav section).
    if (!groups.some((g) => g.id === "timeline")) groups.push({ id: "timeline", label: "Timeline" });
  }
  // ── Graph (M3): deterministic topology layout -> static SVG, runtime pan/zoom. On by default;
  //    config.graph.enabled === false off. The WebGL/semantic-zoom upgrade stays gated (>500 nodes).──
  const graphOn = corpus.meta?.graph?.enabled !== false && model.nodeCount > 0;
  let layout = null;
  if (graphOn) {
    const GRAPH_TITLE = "Graph";
    if (realTitles.has(nfc(GRAPH_TITLE))) throw new Error('generated-doc title collides with a real document: "' + GRAPH_TITLE + '"');
    layout = deriveLayout(model);
    if (!groups.some((g) => g.id === "graph")) groups.push({ id: "graph", label: "Graph" });
    docs[nfc(GRAPH_TITLE)] = {
      group: "graph", icon: "share",
      meta: { type: "relationship graph", status: model.nodeCount + " nodes · " + model.edges.length + " edges" },
      svg: renderGraphSvg(layout, model),
    };
  }

  // ── curated Canvas (M6 JSON Canvas): node positions are truth, read-only, strictly separate from the auto Graph.──
  for (const cf of corpus.canvasFiles) {
    let canvasJson;
    try { canvasJson = JSON.parse(readFileSync(join(docsDir, cf), "utf8")); }
    catch { console.warn("⚠ skipping invalid .canvas: " + cf); continue; }
    const title = "Canvas · " + cf.replace(/\.canvas$/, "");
    if (realTitles.has(nfc(title))) throw new Error('generated-doc title collides with a real document: "' + title + '"');
    if (!groups.some((g) => g.id === "canvas")) groups.push({ id: "canvas", label: "Canvas" });
    docs[nfc(title)] = { group: "canvas", icon: "globe", meta: { type: "JSON Canvas (read-only)" }, svg: renderCanvasSvg(canvasJson) };
  }

  // ── Code map (cartography): off by default; set config.code.dir to a code dir to enable.
  //    module LOC treemap + import deps graph (reuses the topology layout / graph renderer).──
  if (corpus.meta && corpus.meta.code && corpus.meta.code.dir) {
    const scan = scanCode({ dir: resolve(root, corpus.meta.code.dir) });
    if (scan) {
      if (!groups.some((g) => g.id === "code")) groups.push({ id: "code", label: "Code" });
      const tm = "Code · Module map", dg = "Code · Dependencies";
      for (const t of [tm, dg]) if (realTitles.has(nfc(t))) throw new Error('generated-doc title collides with a real document: "' + t + '"');
      docs[nfc(tm)] = { group: "code", icon: "book", meta: { type: "module LOC", status: scan.fileCount + " files · " + scan.totalLoc + " lines" }, svg: renderTreemapSvg(scan) };
      const cm = codeModel(scan);
      docs[nfc(dg)] = { group: "code", icon: "share", meta: { type: "import deps", status: scan.edges.length + " deps" }, svg: renderGraphSvg(deriveLayout(cm), cm) };
    }
  }

  // ── Evolution layer (M4 git temporal): off by default (thin signal below ~200 commits); set config.temporal.enabled to enable.──
  let temporal = null;
  if (corpus.meta && corpus.meta.temporal && corpus.meta.temporal.enabled) {
    temporal = deriveGit({ cwd: root, pathspec: relative(root, docsDir) || "gazette", now });
    if (temporal) {
      const TT = "Evolution";
      if (realTitles.has(nfc(TT))) throw new Error('generated-doc title collides with a real document: "' + TT + '"');
      if (!groups.some((g) => g.id === "temporal")) groups.push({ id: "temporal", label: "Evolution" });
      docs[nfc(TT)] = { group: "temporal", icon: "clock", meta: { type: "temporal", status: temporal.commitCount + " commits" }, body: renderTemporalHtml(temporal) };
    }
  }

  const healthId = nfc(HEALTH_TITLE);
  if (realTitles.has(healthId)) throw new Error('generated-doc title collides with a real document: "' + HEALTH_TITLE + '" - rename that real document');
  if (!groups.some((g) => g.id === "health")) groups.push({ id: "health", label: "Health" });
  const healthClean = healthTotal(health) === 0;
  docs[healthId] = {
    group: "health", icon: "seal",
    meta: { type: "knowledge-base check", status: healthClean ? "OK" : "findings" },
    body: renderHealthHtml(health),
  };

  // ── one render pass over every text body: resolve wiki-links ([[..]] + data-wiki)
  //    against the FULL doc set (real + generated), then sanitize → ship as `html`.
  //    SVG views (graph/code/canvas) are trusted, pre-escaped at build → left as-is. ──
  const assetIndex = buildAssetIndex(join(root, "assets"));   // basename → "assets/…" for image embeds
  const rawBodies = Object.create(null), linksById = Object.create(null); // user-title keys → null proto
  for (const id of Object.keys(docs)) {
    const d = docs[id];
    if (d.body == null) continue;            // SVG views (graph/code/canvas) have no text body
    rawBodies[id] = d.body;
    // md → HTML (with callouts/tags), then image embeds, wiki-links (incl. #anchors;
    // selfId=id for [[#heading]]), sanitize, and heading ids (for #anchor scroll + section embeds).
    const rendered = d.format === "md" ? markdownToHtml(d.body) : d.body;
    const resolved = resolveLinks(resolveImageEmbeds(rendered, assetIndex), makeResolve(docs, id));
    d.html = addHeadingIds(sanitizeBody(resolved));
    // backlink sources: real docs reuse the model's per-format extraction; generated
    // (always HTML) are parsed here. (Closes the old reparse-every-body inefficiency.)
    linksById[id] = id in realLinks ? realLinks[id] : parseHtmlDoc(d.body).bodyLinks.map(nfc);
    delete d.body; delete d.format;
  }

  // note transclusion (a second pass — needs every doc's rendered html): `![[Note]]` /
  // `![[Note#Heading]]` → the target's content inline (one level; nested markers stripped).
  // Snapshot every rendered body FIRST so transclusion reads pre-transclusion content —
  // order-independent, and self/cycle embeds can't pull in already-expanded output.
  const htmlSnapshot = Object.create(null);
  for (const id of Object.keys(docs)) { if (docs[id].html != null) htmlSnapshot[id] = docs[id].html; }
  for (const id of Object.keys(docs)) { if (docs[id].html != null) docs[id].html = transcludeEmbeds(docs[id].html, htmlSnapshot); }

  // backlinks (inbound + a context excerpt) — the runtime renders the panel from this.
  const backlinks = buildBoardBacklinks(rawBodies, linksById);

  // ── atomic write: build into a temp dir, then rename - a failure doesn't break the old dist (grill M5)──
  const tmp = outDir + ".tmp";
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "lib"), { recursive: true });

  writeFileSync(join(tmp, "model.json"), canonicalJSON(model) + "\n");
  writeFileSync(join(tmp, "health.json"), canonicalJSON(health) + "\n");
  if (layout) writeFileSync(join(tmp, "graph.json"), canonicalJSON(layout) + "\n");
  if (temporal) writeFileSync(join(tmp, "temporal.json"), canonicalJSON(temporal) + "\n");

  const STORY = { meta: corpus.meta, groups, docs, backlinks };
  writeFileSync(
    join(tmp, "lib", "content.js"),
    "// ⚠ auto-generated. Do not edit. Source is gazette/*.html; rebuild with: gazette build\n" +
    "window.STORY = " + JSON.stringify(STORY, null, 2) + ";\n"
  );
  for (const f of ENGINE_LIB) copyFileSync(join(TEMPLATE_DIR, "lib", f), join(tmp, "lib", f));

  // theme.css :root is GENERATED from the token source (single source of palette);
  // an optional project theme.json overrides individual tokens (grill L1 / plan §2.1).
  let projectTokens = null;
  const tokensPath = join(root, "theme.json");
  if (existsSync(tokensPath)) {
    try { projectTokens = JSON.parse(readFileSync(tokensPath, "utf8")); }
    catch (e) { throw new Error("theme.json is not valid JSON: " + e.message); }
  }
  const themeCss = readFileSync(join(TEMPLATE_DIR, "lib", "theme.css"), "utf8")
    .replace("/*@TOKENS@*/", emitCssVars(resolveTokens(projectTokens)).trim());
  writeFileSync(join(tmp, "lib", "theme.css"), themeCss);

  let html = readFileSync(join(TEMPLATE_DIR, "index.html"), "utf8");
  const title = [corpus.meta?.title, corpus.meta?.subtitle].filter(Boolean).join(" · ") || "gazette";
  html = html.replace("<!--TITLE-->", escapeHtml(title)).replace("<!--CSP-->", cspMeta());
  let themeOverride = false;
  const projectTheme = join(root, "theme.css");
  if (existsSync(projectTheme)) {
    copyFileSync(projectTheme, join(tmp, "theme.override.css"));
    html = html.replace("<!--THEME_OVERRIDE-->", '<link rel="stylesheet" href="theme.override.css" />');
    themeOverride = true;
  } else {
    html = html.replace("<!--THEME_OVERRIDE-->", "");
  }
  writeFileSync(join(tmp, "index.html"), html);

  let assetsCopied = false;
  const assetsDir = join(root, "assets");
  if (existsSync(assetsDir)) {
    // Skip symlinks entirely (grill M3): dereferencing would copy the TARGETS of
    // symlinks — files possibly OUTSIDE the project — into dist, leaking local data.
    cpSync(assetsDir, join(tmp, "assets"), { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
    assetsCopied = true;
  }

  // swap without a destructive window: move the old dist aside, move tmp into place,
  // and only then drop the backup — so a failure mid-swap leaves the last good build.
  if (existsSync(outDir)) {
    const bak = outDir + ".bak";
    if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
    renameSync(outDir, bak);
    try { renameSync(tmp, outDir); }
    catch (e) { renameSync(bak, outDir); throw e; }
    rmSync(bak, { recursive: true, force: true });
  } else {
    renameSync(tmp, outDir);
  }

  // bundle-budget accounting (plan §8) — flag if the offline artifact balloons
  const bundle = bundleReport(outDir);
  if (bundle.over) {
    console.warn("⚠ bundle " + (bundle.totalBytes / 1048576).toFixed(1) + "MB over budget " + (bundle.budget / 1048576).toFixed(0) + "MB");
  }

  const summary = {
    outDir, fileDocCount: corpus.entries.length, coldCount,
    totalDocs: Object.keys(docs).length, themeOverride, assetsCopied,
    health: health.counts, healthClean, bundleBytes: bundle.totalBytes,
  };
  writeFileSync(metaPath, JSON.stringify({ hash, summary }));
  return summary;
}
