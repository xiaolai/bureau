// code/treemap — slice-and-dice treemap of a code scan: top-level dirs as columns
// (width ∝ dir LOC), files stacked within (height ∝ file LOC). Deterministic;
// per-dir hue; labels escaped. Build-time SVG, rendered via the trusted-SVG path.
import { escapeHtml } from "../shared/escape.mjs";
import { hash32 } from "../shared/hash.mjs";

const W = 820, H = 480;
const color = (g) => "hsl(" + (hash32(g) % 360) + ", 30%, 62%)";
const sum = (fs) => fs.reduce((s, f) => s + f.loc, 0);
const base = (p) => p.split(/[\\/]/).pop();

export function renderTreemapSvg(scan) {
  const files = scan.files;
  if (!files.length) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
  const byDir = Object.create(null); // null-proto: a dir literally named constructor/__proto__ must not hit a prototype member
  for (const f of files) (byDir[f.group] = byDir[f.group] || []).push(f);
  const total = scan.totalLoc || 1;
  const dirs = Object.keys(byDir).sort((a, b) => sum(byDir[b]) - sum(byDir[a]) || (a < b ? -1 : 1));

  let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" font-family="var(--sans)">';
  let x = 0;
  for (const d of dirs) {
    const dl = sum(byDir[d]) || 1;
    const dw = (dl / total) * W;
    const fs = byDir[d].slice().sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : 1));
    let y = 0;
    for (const f of fs) {
      const fh = (f.loc / dl) * H;
      s += '<rect x="' + (x + 0.5) + '" y="' + (y + 0.5) + '" width="' + Math.max(0, dw - 1) + '" height="' + Math.max(0, fh - 1) + '" fill="' + color(d) + '" stroke="var(--paper)" stroke-width="0.5"/>';
      if (fh > 13 && dw > 44) s += '<text x="' + (x + 4) + '" y="' + (y + 13) + '" font-size="10" fill="var(--ink)">' + escapeHtml(base(f.path)) + " · " + f.loc + "</text>";
      y += fh;
    }
    if (dw > 28) s += '<text x="' + (x + 4) + '" y="' + (H - 4) + '" font-size="11" font-weight="700" fill="var(--ink)">' + escapeHtml(d) + "</text>";
    x += dw;
  }
  return s + "</svg>";
}
