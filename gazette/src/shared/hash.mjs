// shared/hash — FNV-1a 32-bit string hash. Stable across runs/platforms (no Math.random /
// seeds), so every caller gets byte-stable output: deterministic layout slots (derive/layout)
// and deterministic per-group hues (render/graph-svg, code/treemap). The ONE hash — no second
// copy (grill L2), same rule as shared/escape and shared/slug.
export function hash32(s) {
  let h = 2166136261 >>> 0;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
