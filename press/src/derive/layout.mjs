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

  // slot = hash % side² is a node's PREFERRED cell, but two ids can hash to the same slot and
  // would then render on top of each other — one node silently hiding another. Resolve collisions
  // with deterministic linear probing: process each group's members in a stable order and, when a
  // preferred slot is taken, step to the next free one. (side² ≥ members, so a free slot always
  // exists.) This preserves determinism; the reflow-free-on-insert property is bounded, as the
  // module header already notes — correctness, a node never vanishing under another, wins here.
  const nodes = {};
  for (const g of groups) {
    const side = sideOf[g];
    const taken = new Set();
    const members = (membersByGroup[g] || []).slice().sort((a, b) => (hash32(a) - hash32(b)) || (a < b ? -1 : a > b ? 1 : 0));
    const r = regionOf[g];
    for (const id of members) {
      let slot = hash32(id) % (side * side);
      while (taken.has(slot)) slot = (slot + 1) % (side * side); // deterministic probe to the next free cell
      taken.add(slot);
      const sx = slot % side, sy = Math.floor(slot / side);
      const x = quantize(r.col * (regionBox + GAP) + PAD + sx * CELL);
      const y = quantize(r.row * (regionBox + GAP) + PAD + sy * CELL);
      nodes[id] = { x, y, group: g };
    }
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
