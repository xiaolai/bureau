// derive/layout — deterministic, reflow-free graph layout (M3). Topology-derived,
// NOT a force simulation (the grill's layout-stability contract): each group is a
// region; within a region a node's slot is a pure function of a stable hash of its
// id, so adding a node never moves existing ones, and the same input → byte-stable
// quantized coordinates. The WebGL/semantic-zoom upgrade is gated on scale (>500
// nodes); this is the always-on legible layout + the build-time coordinate artifact.
import { quantize } from "../services/determinism.mjs";
import { hash32 } from "../shared/hash.mjs";

const CELL = 64;   // px between slots
const PAD = 48;    // px inside a region
const GAP = 64;    // px between regions

export function deriveLayout(model) {
  const ids = Object.keys(model.nodes);
  const groups = [...new Set(ids.map((id) => model.nodes[id].group))].sort();

  // region grid (groups laid out in a square-ish grid, deterministic by sorted group)
  const gCols = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  const regionOf = {};
  groups.forEach((g, i) => { regionOf[g] = { col: i % gCols, row: Math.floor(i / gCols) }; });

  // per-region slot grid: side = next power of 2 ≥ ceil(sqrt(members)). Growing only
  // at power-of-2 boundaries keeps the modulus (slot = hash % side²) stable as nodes
  // are added, so existing nodes don't move — reflow-free within a bucket (the grill
  // layout-stability contract; holds to ~side² nodes per group).
  const membersByGroup = {};
  for (const id of ids) (membersByGroup[model.nodes[id].group] ||= []).push(id);
  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
  const sideOf = {};
  for (const g of groups) sideOf[g] = Math.max(2, nextPow2(Math.ceil(Math.sqrt((membersByGroup[g] || []).length || 1))));
  const regionSpan = (g) => sideOf[g] * CELL + PAD * 2;
  // a uniform region box (max) keeps the region grid rectangular & stable
  const regionBox = Math.max(...groups.map(regionSpan), CELL + PAD * 2);

  const nodes = {};
  for (const id of ids) {
    const g = model.nodes[id].group;
    const side = sideOf[g];
    const slot = hash32(id) % (side * side);
    const sx = slot % side, sy = Math.floor(slot / side);
    const r = regionOf[g];
    const x = quantize(r.col * (regionBox + GAP) + PAD + sx * CELL);
    const y = quantize(r.row * (regionBox + GAP) + PAD + sy * CELL);
    nodes[id] = { x, y, group: g };
  }

  const gRows = Math.ceil(groups.length / gCols);
  return {
    nodes,
    edges: model.edges.map((e) => ({ source: e.source, target: e.target })),
    groups,
    width: quantize(gCols * (regionBox + GAP)),
    height: quantize(gRows * (regionBox + GAP)),
    regionBox,
  };
}
