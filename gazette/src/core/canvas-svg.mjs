// core/canvas-svg — render a JSON Canvas (jsoncanvas.org) to a static SVG (M6).
// Curated layouts: node positions are TRUTH and rendered as-is (never auto-laid-out
// — kept strictly separate from the derived graph). Labels escaped (XSS-safe).
import { escapeHtml } from "../shared/escape.mjs";

const NW = 200, NH = 60; // defaults when a node omits width/height
// coerce a JSON coordinate to a finite number — never let a string reach an SVG
// attribute (a value like `0" onload=…` would break out of the attribute → XSS).
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

export function renderCanvasSvg(canvas) {
  const nodes = (canvas && canvas.nodes) || [];
  const edges = (canvas && canvas.edges) || [];
  if (!nodes.length) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';

  const x = (n) => num(n.x), y = (n) => num(n.y), w = (n) => num(n.width, NW), h = (n) => num(n.height, NH);
  const minX = Math.min(...nodes.map(x));
  const minY = Math.min(...nodes.map(y));
  const maxX = Math.max(...nodes.map((n) => x(n) + w(n)));
  const maxY = Math.max(...nodes.map((n) => y(n) + h(n)));
  const W = maxX - minX, H = maxY - minY;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const cx = (n) => x(n) + w(n) / 2;
  const cy = (n) => y(n) + h(n) / 2;

  let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + minX + " " + minY + " " + W + " " + H +
    '" width="' + W + '" height="' + H + '" font-family="var(--sans)">';
  for (const e of edges) {
    const a = byId[e.fromNode], b = byId[e.toNode];
    if (!a || !b) continue;
    s += '<line x1="' + cx(a) + '" y1="' + cy(a) + '" x2="' + cx(b) + '" y2="' + cy(b) + '" stroke="var(--line-strong)" stroke-width="1.5" opacity="0.7"/>';
  }
  for (const n of nodes) {
    s += '<rect x="' + x(n) + '" y="' + y(n) + '" width="' + w(n) + '" height="' + h(n) + '" rx="8" fill="var(--paper-2)" stroke="var(--line-strong)"/>';
    const text = String(n.text || n.label || n.file || "").split("\n")[0].slice(0, 48);
    s += '<text x="' + (x(n) + 12) + '" y="' + (y(n) + 24) + '" font-size="13" fill="var(--ink)">' + escapeHtml(text) + "</text>";
  }
  return s + "</svg>";
}
