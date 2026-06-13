// runtime/dom — browser-coupled rendering + wiring. Concatenated after pure.mjs +
// viz.mjs + shared/escape.mjs by src/build-runtime.mjs into the single offline app.js.
// Doc bodies arrive PRE-RENDERED as sanitized HTML (wiki-links already resolved at
// build); the runtime mounts that HTML and HYDRATES the interactive widgets:
// `.viz` → ECharts (charts/graphs) or a sortable table, `.mermaid` → mermaid, SVG
// views → pan/zoom. Uses window/document; covered by the jsdom harness.
import { escapeHtml, escapeAttr } from "../shared/escape.mjs";
import { nfc, injectStyle, metaRow, icon } from "./pure.mjs";
import { renderViz, VIZ_PALETTE } from "./viz.mjs";

const STORY = window.STORY;
const docs = STORY.docs;
const docNames = Object.keys(docs);
// own-property test: doc ids are user titles, so a route like #/constructor must NOT match
// an inherited Object property (which would crash downstream).
const hasDoc = (k) => Object.prototype.hasOwnProperty.call(docs, k);

// home fallback: meta.home should resolve (build validates), else first doc (grill H5)
const HOME = hasDoc(nfc(STORY.meta.home)) ? nfc(STORY.meta.home) : docNames[0];

// route = #/<doc>[?h=<heading-slug>]. Returns the resolved doc name + heading anchor.
function parseRoute() {
  const rawHash = (location.hash || "").replace(/^#\/?/, "");
  const qi = rawHash.indexOf("?");
  const docPart = qi < 0 ? rawHash : rawHash.slice(0, qi);
  let name = HOME;
  try { const n = nfc(decodeURIComponent(docPart)); if (hasDoc(n)) name = n; } catch (e) { /* HOME */ }
  let anchor = "";
  if (qi >= 0) for (const kv of rawHash.slice(qi + 1).split("&")) { const i = kv.indexOf("="); if (i < 0) continue; if (kv.slice(0, i) === "h") { try { anchor = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* ignore */ } } }
  return { name, anchor };
}

// ── sidebar collapse state ────────────────────────────────────────────────────
// Cabinet groups are collapsible <details>. We persist only the COLLAPSED set (so a
// newly-added group defaults open) in localStorage, namespaced by gazette title —
// every file:// page shares the null origin, so two boards on one machine must not
// clobber each other. Storage can be absent or throwing on file://; degrade to memory.
const NAV_KEY = "bureau:nav:" + (STORY.meta.title || "");
function readCollapsed() {
  try { const v = JSON.parse(localStorage.getItem(NAV_KEY) || "[]"); return new Set(Array.isArray(v) ? v : []); }
  catch (e) { return new Set(); }
}
const navCollapsed = readCollapsed();
function saveCollapsed() {
  try { localStorage.setItem(NAV_KEY, JSON.stringify([...navCollapsed])); } catch (e) { /* file:// storage blocked — in-memory only */ }
}
const NAV_CHEVRON = '<svg class="nav-group__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';

function buildNav() {
  const nav = document.getElementById("nav");
  let html = "";
  STORY.groups.forEach((g) => {
    const items = docNames.filter((n) => docs[n].group === g.id);
    if (!items.length) return;
    const open = navCollapsed.has(g.id) ? "" : " open";
    html += '<details class="nav-group" data-group="' + escapeAttr(g.id) + '"' + open + ">" +
      '<summary class="nav-group__label">' + NAV_CHEVRON +
      '<span class="nav-group__text">' + escapeHtml(g.label) + "</span>" +
      '<span class="nav-group__count">' + items.length + "</span></summary>" +
      '<div class="nav-group__items">';
    items.forEach((n) => {
      html += '<a class="nav-item" data-doc="' + escapeAttr(n) + '" href="#/' + encodeURIComponent(n) +
        '"><span class="nav-item__icon">' + icon(docs[n].icon) + '</span><span class="nav-item__label">' + escapeHtml(n) + "</span></a>";
    });
    html += "</div></details>";
  });
  nav.innerHTML = html;
  // Persist on user toggle. The `toggle` event does NOT bubble, so delegate on the
  // capture phase (one listener survives the innerHTML above since it's on #nav).
  nav.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d || !d.classList || !d.classList.contains("nav-group")) return;
    if (d.open) navCollapsed.delete(d.dataset.group); else navCollapsed.add(d.dataset.group);
    saveCollapsed();
  }, true);
}

const BL_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7H6a3 3 0 0 0 0 6h2M12 7h2a3 3 0 0 1 0 6h-2M7.5 10h5"/></svg>';
function backlinkPanel(name) {
  // own-property + Array.isArray: backlinks is keyed by user title; never read an inherited
  // member (e.g. a doc literally named "constructor") or a non-array as the link list.
  const raw = STORY.backlinks && Object.prototype.hasOwnProperty.call(STORY.backlinks, name) ? STORY.backlinks[name] : null;
  const list = Array.isArray(raw) ? raw : [];
  let html = '<div class="backlinks"><div class="backlinks__head">' + BL_ICON + "Backlinks <span class=\"backlinks__count\">" + list.length + "</span></div>";
  if (!list.length) return html + '<div class="backlinks__empty">Nothing links here yet.</div></div>';
  html += '<div class="backlinks__list">';
  list.forEach((b) => {
    const ic = icon(hasDoc(b.source) ? docs[b.source].icon : "file");
    html += '<a class="backlink-card" href="#/' + encodeURIComponent(b.source) + '"><span class="backlink-card__icon">' + ic +
      '</span><span class="backlink-card__body"><span class="backlink-card__title">' + escapeHtml(b.source) +
      '</span><span class="backlink-card__ctx">' + escapeHtml(b.excerpt || "") + "</span></span></a>";
  });
  return html + "</div></div>";
}

let mmdCounter = 0;
function renderDoc(name) {
  const doc = docs[name];
  disposeCharts();
  const canvas = document.getElementById("canvas");
  const groupLabel = (STORY.groups.find((g) => g.id === doc.group) || {}).label || "";
  const crumb = '<div class="crumb"><a href="#/' + encodeURIComponent(HOME) + '">' + escapeHtml(STORY.meta.title) +
    '</a><span class="crumb__sep">/</span><span class="crumb__group">' + escapeHtml(groupLabel) +
    '</span><span class="crumb__sep">/</span><span class="crumb__cur">' + escapeHtml(name) + "</span></div>";
  if (doc.svg) {
    // build-generated trusted SVG (e.g. the graph view); labels pre-escaped at build.
    canvas.innerHTML = crumb + '<article class="doc">' + metaRow(doc.meta) + '<div class="graph-host"></div></article>';
    attachPanZoom(canvas.querySelector(".graph-host"), doc.svg);
  } else {
    // pre-rendered, sanitized HTML body; hydrate widgets after mount.
    canvas.innerHTML = crumb + '<article class="doc">' + metaRow(doc.meta) + '<div class="doc-body markdown">' + (doc.html || "") + "</div>" + backlinkPanel(name) + "</article>";
    hydrateViz(canvas);
    wireSortable(canvas);
    renderMermaid(canvas);
  }
  canvas.scrollTop = 0;
  document.querySelectorAll(".nav-item").forEach((el) => {
    const on = el.getAttribute("data-doc") === name;
    el.classList.toggle("nav-item--active", on);
    // keep the current page visible: open its (possibly collapsed) cabinet group
    if (on) { const grp = el.closest("details.nav-group"); if (grp && !grp.open) grp.open = true; }
  });
  document.title = name + " · " + STORY.meta.title;
}

// ── viz hydration (ECharts charts/graphs + sortable tables) ───────────────────
let vizCharts = [];
function disposeCharts() { vizCharts.forEach((c) => { try { c.dispose(); } catch (e) { /* ignore */ } }); vizCharts = []; }

function vizPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => (cs.getPropertyValue(n) || "").trim();
  const p = [v("--accent"), v("--accent-2"), v("--accent-3"), v("--accent-4")].filter(Boolean);
  return p.length ? p.concat(VIZ_PALETTE).slice(0, 8) : VIZ_PALETTE;
}
function vizParsers() {
  return {
    json: (s) => JSON.parse(s),
    yaml: (s) => (window.jsyaml ? window.jsyaml.load(s) : JSON.parse(s)),
    csv: (s) => window.Papa.parse(s, { header: true, skipEmptyLines: true, dynamicTyping: true }).data,
  };
}

function hydrateViz(scope) {
  const P = vizParsers(), palette = vizPalette();
  scope.querySelectorAll(".viz").forEach((el) => {
    const text = el.textContent || "";
    if (text.length > VIZ_MAX) { el.innerHTML = '<div class="viz-error">data too large to render (' + text.length + " chars, limit " + VIZ_MAX + ") — reduce the dataset</div>"; return; }
    const spec = {
      type: (el.getAttribute("data-type") || "chart").toLowerCase(),
      kind: el.getAttribute("data-kind") || "",
      format: el.getAttribute("data-format") || "auto",
      text,
    };
    const opts = {
      palette,
      title: el.getAttribute("data-title") || "",
      stack: el.hasAttribute("data-stack"),
      smooth: el.hasAttribute("data-smooth"),
      directed: el.hasAttribute("data-directed"),
      layout: el.getAttribute("data-layout") || "",
    };
    let res;
    try { res = renderViz(spec, P, opts); }
    catch (e) { el.innerHTML = '<div class="viz-error">viz error: ' + escapeHtml(String((e && e.message) || e)) + "</div>"; return; }

    if (res.mode === "html") { el.innerHTML = res.html; el.classList.add("viz--ready"); return; }

    // echarts (chart/graph)
    if (!window.echarts) { el.innerHTML = '<div class="viz-error">charts unavailable (echarts not loaded)</div>'; return; }
    el.textContent = ""; // drop the raw data text
    const host = document.createElement("div");
    host.className = "viz-chart";
    host.style.width = "100%";
    // clamp data-height to a sane range so malformed content can't create a giant render surface
    const reqH = parseInt(el.getAttribute("data-height"), 10);
    const h = Number.isFinite(reqH) ? Math.max(120, Math.min(2000, reqH)) : (spec.type === "graph" ? 440 : 320);
    host.style.height = h + "px";
    el.appendChild(host);
    el.classList.add("viz--ready");
    let chart;
    try {
      chart = window.echarts.init(host, null, { renderer: "svg" });
      const opt = res.option || {};
      if (!opt.textStyle) {
        const cs = getComputedStyle(document.documentElement);
        const cssv = (n, d) => ((cs.getPropertyValue(n) || "").trim() || d);
        // follow the theme so charts stay legible in dark themes (text uses --ink)
        opt.textStyle = { fontFamily: cssv("--sans", "sans-serif"), color: cssv("--ink-soft", cssv("--ink", "#333")) };
      }
      chart.setOption(opt);
      vizCharts.push(chart);
    } catch (e) {
      if (chart) try { chart.dispose(); } catch (_) { /* ignore */ }
      el.innerHTML = '<div class="viz-error">chart error: ' + escapeHtml(String((e && e.message) || e)) + "</div>";
    }
  });
}

// click/Enter on a wb-table header → stable sort by that column (numeric if .num)
function wireSortable(scope) {
  scope.querySelectorAll("table.wb-table").forEach((table) => {
    const tbody = table.querySelector("tbody");
    if (!tbody) return;
    table.querySelectorAll("th[data-col]").forEach((th) => {
      const run = () => sortBy(table, tbody, th);
      th.addEventListener("click", run);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
    });
  });
}
function sortBy(table, tbody, th) {
  const col = +th.getAttribute("data-col");
  const num = th.classList.contains("num");
  const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
  table.querySelectorAll("th[data-col]").forEach((h) => h.setAttribute("aria-sort", "none"));
  th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
  const rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
  rows.sort((a, b) => {
    const x = a.children[col] ? a.children[col].textContent : "";
    const y = b.children[col] ? b.children[col].textContent : "";
    if (num) return ((parseFloat(x) || 0) - (parseFloat(y) || 0)) * dir;
    return x.localeCompare(y) * dir;
  });
  rows.forEach((r) => tbody.appendChild(r));
}

// ── Mermaid + SVG pan/zoom (floating toolbar + drag + initial fit-to-viewport) ──
function pzIcon(inner) { return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>"; }
const PZ = {
  in: pzIcon('<line x1="10" y1="6" x2="10" y2="14"/><line x1="6" y1="10" x2="14" y2="10"/>'),
  out: pzIcon('<line x1="6" y1="10" x2="14" y2="10"/>'),
  reset: pzIcon('<path d="M15 7a5.5 5.5 0 1 0 .7 5"/><path d="M15 3.5V7h-3.5"/>'),
  left: pzIcon('<path d="M12 6l-4 4 4 4"/>'),
  right: pzIcon('<path d="M8 6l4 4-4 4"/>'),
  up: pzIcon('<path d="M6 12l4-4 4 4"/>'),
  down: pzIcon('<path d="M6 8l4 4 4-4"/>'),
  grip: '<svg viewBox="0 0 20 20" fill="currentColor" stroke="none"><circle cx="8" cy="6" r="1.1"/><circle cx="12" cy="6" r="1.1"/><circle cx="8" cy="10" r="1.1"/><circle cx="12" cy="10" r="1.1"/><circle cx="8" cy="14" r="1.1"/><circle cx="12" cy="14" r="1.1"/></svg>',
};
function attachPanZoom(host, svg) {
  host.classList.add("mmd-has-pz");
  host.innerHTML =
    '<div class="mmd-viewport"><div class="mmd-pan">' + svg + "</div></div>" +
    '<div class="mmd-tools">' +
    '<span class="mmd-tools__grip" title="drag toolbar">' + PZ.grip + "</span>" +
    '<button class="mmd-tool" data-a="in" title="zoom in">' + PZ.in + "</button>" +
    '<button class="mmd-tool" data-a="out" title="zoom out">' + PZ.out + "</button>" +
    '<button class="mmd-tool" data-a="reset" title="reset">' + PZ.reset + "</button>" +
    '<span class="mmd-tool__sep"></span>' +
    '<button class="mmd-tool" data-a="left" title="left">' + PZ.left + "</button>" +
    '<button class="mmd-tool" data-a="right" title="right">' + PZ.right + "</button>" +
    '<button class="mmd-tool" data-a="up" title="up">' + PZ.up + "</button>" +
    '<button class="mmd-tool" data-a="down" title="down">' + PZ.down + "</button>" +
    "</div>";
  const vp = host.querySelector(".mmd-viewport"), pan = host.querySelector(".mmd-pan");
  const svgEl = pan.querySelector("svg");
  if (svgEl) { svgEl.style.maxWidth = "100%"; svgEl.style.height = "auto"; }
  let s = 1, tx = 0, ty = 0, s0 = 1, tx0 = 0, ty0 = 0;
  const MIN = 0.4, MAX = 8, STEP = 1.25, NUDGE = 64;
  function apply() { pan.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")"; }
  function zoomAbout(cx, cy, k) { const ns = Math.max(MIN, Math.min(MAX, s * k)); if (ns === s) return; tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply(); }
  function ctr() { const r = vp.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }
  host.querySelector(".mmd-tools").addEventListener("click", (e) => {
    const b = e.target.closest(".mmd-tool"); if (!b) return;
    const a = b.dataset.a, c = ctr();
    if (a === "in") zoomAbout(c[0], c[1], STEP);
    else if (a === "out") zoomAbout(c[0], c[1], 1 / STEP);
    else if (a === "reset") { s = s0; tx = tx0; ty = ty0; apply(); }
    else if (a === "left") { tx += NUDGE; apply(); }
    else if (a === "right") { tx -= NUDGE; apply(); }
    else if (a === "up") { ty += NUDGE; apply(); }
    else if (a === "down") { ty -= NUDGE; apply(); }
  });
  const tools = host.querySelector(".mmd-tools"), grip = tools.querySelector(".mmd-tools__grip");
  let gdrag = false, gx = 0, gy = 0;
  grip.addEventListener("pointerdown", (e) => { e.preventDefault(); gdrag = true; const tr = tools.getBoundingClientRect(), hr = host.getBoundingClientRect(); tools.style.left = (tr.left - hr.left) + "px"; tools.style.top = (tr.top - hr.top) + "px"; tools.style.right = "auto"; tools.style.bottom = "auto"; gx = e.clientX; gy = e.clientY; try { grip.setPointerCapture(e.pointerId); } catch (_) { } });
  grip.addEventListener("pointermove", (e) => { if (!gdrag) return; const hr = host.getBoundingClientRect(), tr = tools.getBoundingClientRect(); let nl = parseFloat(tools.style.left) + (e.clientX - gx), nt = parseFloat(tools.style.top) + (e.clientY - gy); nl = Math.max(4, Math.min(hr.width - tr.width - 4, nl)); nt = Math.max(4, Math.min(hr.height - tr.height - 4, nt)); tools.style.left = nl + "px"; tools.style.top = nt + "px"; gx = e.clientX; gy = e.clientY; });
  function gend(e) { if (!gdrag) return; gdrag = false; try { grip.releasePointerCapture(e.pointerId); } catch (_) { } }
  grip.addEventListener("pointerup", gend); grip.addEventListener("pointercancel", gend);
  let drag = false, lx = 0, ly = 0;
  vp.addEventListener("pointerdown", (e) => { drag = true; lx = e.clientX; ly = e.clientY; vp.classList.add("is-grabbing"); try { vp.setPointerCapture(e.pointerId); } catch (_) { } });
  vp.addEventListener("pointermove", (e) => { if (!drag) return; tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); });
  function end(e) { if (!drag) return; drag = false; vp.classList.remove("is-grabbing"); try { vp.releasePointerCapture(e.pointerId); } catch (_) { } }
  vp.addEventListener("pointerup", end); vp.addEventListener("pointercancel", end);
  vp.addEventListener("wheel", (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAbout(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? STEP : 1 / STEP); }, { passive: false });
  apply();
  requestAnimationFrame(() => {
    const vw = vp.getBoundingClientRect().width, ph = pan.getBoundingClientRect().height || 320, maxH = Math.round(window.innerHeight * 0.82);
    if (ph > maxH) { s = maxH / ph; tx = (vw - vw * s) / 2; apply(); vp.style.height = maxH + "px"; }
    else { vp.style.height = ph + "px"; }
    s0 = s; tx0 = tx; ty0 = ty;
  });
}

const BASE_FONT = 16, THRESHOLD = 11, MMD_MAX = 20000; // cap diagram source so a giant graph can't freeze the UI
const VIZ_MAX = 200000; // cap viz/chart source text (datasets are larger than diagrams) so parsing can't hang the UI
// flowchart node palette from theme vars (dedicated --mmd-node-* override the base
// surface tokens), so diagrams follow the active theme instead of a fixed light fill.
function mermaidPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => ((cs.getPropertyValue(n) || "").trim() || d);
  return {
    fill: v("--mmd-node", v("--paper-2", "#efeae0")),
    stroke: v("--mmd-node-stroke", v("--line-strong", "#ddd6c8")),
    color: v("--mmd-node-text", v("--ink", "#22201b")),
    link: v("--mmd-edge", v("--faint", "#b8b0a0")),
  };
}
function renderMermaid(scope) {
  if (!window.mermaid) return;
  const palette = mermaidPalette();
  scope.querySelectorAll(".mermaid").forEach((el) => {
    const src = el.textContent || "";
    if (src.length > MMD_MAX) { el.innerHTML = '<pre class="mermaid-error">diagram too large to render (' + src.length + " chars, limit " + MMD_MAX + ") — split it into smaller diagrams</pre>"; return; }
    const code = injectStyle(src, palette);
    const id = "mmd-" + mmdCounter++;
    try {
      window.mermaid.render(id, code).then(({ svg }) => {
        if (!el.isConnected) return; // route changed away before render finished — element is stale
        attachPanZoom(el, svg);
        const s = el.querySelector("svg");
        const natural = (s && s.viewBox && s.viewBox.baseVal && s.viewBox.baseVal.width) || 0;
        const shown = s ? s.getBoundingClientRect().width : 0;
        if (natural && shown) {
          const eff = BASE_FONT * (shown / natural);
          if (eff < THRESHOLD) {
            const a = document.createElement("div");
            a.className = "mmd-alert mmd-alert--warn";
            a.innerHTML = "⚠ This diagram is too large - effective font size ~ <b>" + eff.toFixed(1) + "px</b> (limit " + THRESHOLD + "px). <b>split it</b>: extract a part into a sub-page and drill in via a [[wiki-link]]. ";
            el.insertAdjacentElement("afterend", a);
          }
        }
      }).catch((e) => { if (!el.isConnected) return; el.innerHTML = '<pre class="mermaid-error">diagram render failed: ' + escapeHtml(String((e && e.message) || e)) + "</pre>"; });
    } catch (e) { if (el.isConnected) el.innerHTML = '<pre class="mermaid-error">diagram render failed</pre>'; }
  });
}

function route() {
  const r = parseRoute();
  renderDoc(r.name);
  // scroll to a [[Note#heading]] target (heading ids are assigned at build). Scope the
  // lookup to the rendered doc so a heading id that collides with a shell id (nav/canvas)
  // scrolls the heading, not the chrome.
  if (r.anchor) requestAnimationFrame(() => {
    const canvas = document.getElementById("canvas");
    const sel = '[id="' + (window.CSS && CSS.escape ? CSS.escape(r.anchor) : r.anchor.replace(/["\\]/g, "\\$&")) + '"]';
    const el = canvas && canvas.querySelector(sel);
    if (el) el.scrollIntoView({ block: "start" });
  });
}
function init() {
  document.getElementById("brand-title").textContent = STORY.meta.title;
  document.getElementById("brand-sub").textContent = STORY.meta.subtitle || "";
  buildNav();
  if (window.mermaid) {
    const mmdBg = (getComputedStyle(document.documentElement).getPropertyValue("--mmd-bg") || "").trim() || "#fbfaf6";
    // securityLevel "strict" makes mermaid sanitize its own generated SVG (it bundles
    // DOMPurify) and htmlLabels:false keeps labels as plain SVG <text> — together they
    // close the runtime path where author diagram source could inject HTML, since the
    // mermaid SVG is inserted via innerHTML and never passes the build sanitizer.
    window.mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", theme: "base",
      themeVariables: { darkMode: false, background: mmdBg, fontSize: "16px" },
      flowchart: { curve: "basis", htmlLabels: false, padding: 14, useMaxWidth: true },
    });
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => vizCharts.forEach((c) => { try { c.resize(); } catch (e) { /* ignore */ } }));
  route();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
