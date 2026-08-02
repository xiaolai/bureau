// render/graph-svg — render a deriveLayout() result to a static, themed, deterministic
// SVG (M3), now carrying the canvas projection's level-of-detail tiers (ADR-0002).
// Build-time; node titles (user content) are escaped. Colors use CSS vars + a deterministic
// per-group hue so the theme applies and the graph stays readable.
//
// LOD (ADR-0002 Decision C): all three tiers are emitted into the ONE svg as
// `<g class="lod lod--far|mid|near">`; the runtime sets `data-lod` on the host from the current
// zoom scale and CSS reveals the matching tier. With JS off nothing sets `data-lod`, and CSS shows
// `mid` — byte-identical to the pre-ADR render, so the projection is strictly additive.
//
// STATE (Decision D): fill encodes the WORST state a node is in; the per-group hue moves to the
// stroke so grouping stays legible without competing for the fill channel.
import { escapeHtml } from "../shared/escape.mjs";
import { hash32 } from "../shared/hash.mjs";

const R = 7;
const groupColor = (g) => "hsl(" + (hash32(g) % 360) + ", 32%, 56%)";
// every value interpolated into an SVG numeric attribute goes through this: a non-finite coord
// (NaN/Infinity/non-number) from a hand-built layout must not land raw in an attribute.
const fin = (v, d = 0) => (Number.isFinite(v) ? v : (Number.isFinite(+v) ? +v : d));

// The state a node is painted with, worst-first. `flag` (an unearned canonical tier) outranks
// freshness: a page nothing accepted backs is a trust problem, not a staleness one.
const STATE_FILL = {
  unbacked: "var(--rust-deep, #a8322a)",
  unauthorized: "var(--rust-deep, #a8322a)",
  stale: "var(--rust-deep, #a8322a)",
  "needs-review": "#b57c14",
  modified: "var(--accent-deep, #4a5d6e)",
  current: "var(--ink-soft, #6b7280)",
};
export function nodeState(st) {
  if (!st) return "current";
  // a trust flag (unearned/void canonical) outranks freshness. `stale` = a content-bound approval the
  // page was edited past (ADR-0004); it shares the freshness-`stale` fill — both mean "not to be trusted".
  if (st.flag === "unbacked" || st.flag === "unauthorized" || st.flag === "stale") return st.flag;
  const f = st.freshness;
  if (f === "stale" || f === "needs-review" || f === "modified") return f;
  return "current";
}

export function renderGraphSvg(layout, model, state = null) {
  const W = fin(layout.width, 100) || 100, H = fin(layout.height, 100) || 100;
  let s = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" font-family="var(--sans)" class="wb-canvas">';

  // edges (skip those whose endpoint wasn't placed — e.g. dangling targets). own-property
  // guard: a dangling target named an inherited key (constructor/toString) must be skipped,
  // not resolve to a prototype member and emit NaN coordinates.
  const placed = (k) => Object.prototype.hasOwnProperty.call(layout.nodes, k);
  for (const e of layout.edges) {
    const a = placed(e.source) ? layout.nodes[e.source] : null, b = placed(e.target) ? layout.nodes[e.target] : null;
    if (!a || !b) continue;
    s += '<line x1="' + fin(a.x) + '" y1="' + fin(a.y) + '" x2="' + fin(b.x) + '" y2="' + fin(b.y) + '" stroke="var(--line-strong)" stroke-width="1" opacity="0.7"/>';
  }

  const ids = Object.keys(layout.nodes); // deriveLayout builds this deterministically
  const stateOf = (id) => nodeState(state && Object.prototype.hasOwnProperty.call(state, id) ? state[id] : null);
  const fillOf = (id) => STATE_FILL[stateOf(id)] || STATE_FILL.current;

  // ── FAR: one box per region + an unhealthy count, nodes as bare dots (no labels) ──
  // Region bounds are derived from the placed nodes, so this needs no new layout data.
  const box = {};
  for (const id of ids) {
    const nd = layout.nodes[id], g = nd.group;
    const b = (box[g] ||= { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, n: 0, bad: 0 });
    b.minX = Math.min(b.minX, fin(nd.x)); b.minY = Math.min(b.minY, fin(nd.y));
    b.maxX = Math.max(b.maxX, fin(nd.x)); b.maxY = Math.max(b.maxY, fin(nd.y));
    b.n++; if (stateOf(id) !== "current") b.bad++;
  }
  s += '<g class="lod lod--far">';
  for (const g of Object.keys(box).sort()) { // sorted → byte-stable output
    const b = box[g], pad = R * 3;
    const x = b.minX - pad, y = b.minY - pad, w = (b.maxX - b.minX) + pad * 2, h = (b.maxY - b.minY) + pad * 2;
    s += '<rect x="' + fin(x) + '" y="' + fin(y) + '" width="' + fin(w) + '" height="' + fin(h) + '" rx="10" fill="none" stroke="' + groupColor(g) + '" stroke-width="2" opacity="0.65"/>';
    s += '<text x="' + fin(x + 8) + '" y="' + fin(y + 20) + '" font-size="15" font-weight="600" fill="var(--ink-soft)">' +
      escapeHtml(g || "root") + (b.bad ? " · " + b.bad + "/" + b.n + " need attention" : " · " + b.n) + "</text>";
  }
  for (const id of ids) {
    const nd = layout.nodes[id];
    s += '<circle cx="' + fin(nd.x) + '" cy="' + fin(nd.y) + '" r="' + (R - 2) + '" fill="' + fillOf(id) + '" opacity="0.9"/>';
  }
  s += "</g>";

  // ── MID: nodes + titles (the pre-ADR view, now state-filled) ──
  s += '<g class="lod lod--mid">';
  for (const id of ids) {
    const nd = layout.nodes[id];
    const title = (model.nodes[id] && model.nodes[id].title) || id;
    const nx = fin(nd.x), ny = fin(nd.y);
    s += '<circle cx="' + nx + '" cy="' + ny + '" r="' + R + '" fill="' + fillOf(id) + '" stroke="' + groupColor(nd.group) + '" stroke-width="2"/>';
    s += '<text x="' + (nx + R + 3) + '" y="' + (ny + 4) + '" font-size="11" fill="var(--ink-soft)">' + escapeHtml(title) + "</text>";
  }
  s += "</g>";

  // ── NEAR: title + trust tier + the state word, so "what exactly is wrong here" is readable ──
  s += '<g class="lod lod--near">';
  for (const id of ids) {
    const nd = layout.nodes[id];
    const title = (model.nodes[id] && model.nodes[id].title) || id;
    const st = state && Object.prototype.hasOwnProperty.call(state, id) ? state[id] : null;
    const tier = (st && st.trust) || (model.nodes[id] && (model.nodes[id].trust || model.nodes[id].status)) || null;
    const word = stateOf(id);
    const nx = fin(nd.x), ny = fin(nd.y);
    s += '<circle cx="' + nx + '" cy="' + ny + '" r="' + (R + 1) + '" fill="' + fillOf(id) + '" stroke="' + groupColor(nd.group) + '" stroke-width="2"/>';
    s += '<text x="' + (nx + R + 5) + '" y="' + (ny + 1) + '" font-size="11" font-weight="600" fill="var(--ink)">' + escapeHtml(title) + "</text>";
    const sub = [tier ? String(tier) : null, word !== "current" ? word : null].filter(Boolean).join(" · ");
    if (sub) s += '<text x="' + (nx + R + 5) + '" y="' + (ny + 13) + '" font-size="9" fill="var(--ink-soft)">' + escapeHtml(sub) + "</text>";
  }
  s += "</g>";

  s += "</svg>";
  return s;
}
