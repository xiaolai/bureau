// render/graph-svg — render a deriveLayout() result to a static, themed, deterministic
// SVG (M3). Build-time; node titles (user content) are escaped. Colors use CSS vars
// + a deterministic per-group hue so the theme applies and the graph stays readable.
import { escapeHtml } from "../shared/escape.mjs";
import { hash32 } from "../shared/hash.mjs";

const R = 7;
const groupColor = (g) => "hsl(" + (hash32(g) % 360) + ", 32%, 56%)";

export function renderGraphSvg(layout, model) {
  const W = layout.width || 100, H = layout.height || 100;
  let s = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" font-family="var(--sans)">';

  // edges (skip those whose endpoint wasn't placed — e.g. dangling targets). own-property
  // guard: a dangling target named an inherited key (constructor/toString) must be skipped,
  // not resolve to a prototype member and emit NaN coordinates.
  const placed = (k) => Object.prototype.hasOwnProperty.call(layout.nodes, k);
  for (const e of layout.edges) {
    const a = placed(e.source) ? layout.nodes[e.source] : null, b = placed(e.target) ? layout.nodes[e.target] : null;
    if (!a || !b) continue;
    s += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="var(--line-strong)" stroke-width="1" opacity="0.7"/>';
  }
  // nodes + labels (titles escaped — XSS)
  for (const id of Object.keys(layout.nodes)) {
    const n = layout.nodes[id];
    const title = (model.nodes[id] && model.nodes[id].title) || id;
    s += '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + R + '" fill="' + groupColor(n.group) + '" stroke="var(--paper)" stroke-width="1.5"/>';
    s += '<text x="' + (n.x + R + 3) + '" y="' + (n.y + 4) + '" font-size="11" fill="var(--ink-soft)">' + escapeHtml(title) + "</text>";
  }
  s += "</svg>";
  return s;
}
