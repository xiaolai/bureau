// render/graph-svg — render a deriveLayout() result to a static, themed, deterministic
// SVG (M3). Build-time; node titles (user content) are escaped. Colors use CSS vars
// + a deterministic per-group hue so the theme applies and the graph stays readable.
import { escapeHtml } from "../shared/escape.mjs";
import { hash32 } from "../shared/hash.mjs";

const R = 7;
const groupColor = (g) => "hsl(" + (hash32(g) % 360) + ", 32%, 56%)";
// every value interpolated into an SVG numeric attribute goes through this: a non-finite coord
// (NaN/Infinity/non-number) from a hand-built layout must not land raw in an attribute.
const fin = (v, d = 0) => (Number.isFinite(v) ? v : (Number.isFinite(+v) ? +v : d));

export function renderGraphSvg(layout, model) {
  const W = fin(layout.width, 100) || 100, H = fin(layout.height, 100) || 100;
  let s = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" font-family="var(--sans)">';

  // edges (skip those whose endpoint wasn't placed — e.g. dangling targets). own-property
  // guard: a dangling target named an inherited key (constructor/toString) must be skipped,
  // not resolve to a prototype member and emit NaN coordinates.
  const placed = (k) => Object.prototype.hasOwnProperty.call(layout.nodes, k);
  for (const e of layout.edges) {
    const a = placed(e.source) ? layout.nodes[e.source] : null, b = placed(e.target) ? layout.nodes[e.target] : null;
    if (!a || !b) continue;
    s += '<line x1="' + fin(a.x) + '" y1="' + fin(a.y) + '" x2="' + fin(b.x) + '" y2="' + fin(b.y) + '" stroke="var(--line-strong)" stroke-width="1" opacity="0.7"/>';
  }
  // nodes + labels (titles escaped — XSS)
  for (const id of Object.keys(layout.nodes)) {
    const nd = layout.nodes[id];
    const title = (model.nodes[id] && model.nodes[id].title) || id;
    const nx = fin(nd.x), ny = fin(nd.y);
    s += '<circle cx="' + nx + '" cy="' + ny + '" r="' + R + '" fill="' + groupColor(nd.group) + '" stroke="var(--paper)" stroke-width="1.5"/>';
    s += '<text x="' + (nx + R + 3) + '" y="' + (ny + 4) + '" font-size="11" fill="var(--ink-soft)">' + escapeHtml(title) + "</text>";
  }
  s += "</svg>";
  return s;
}
