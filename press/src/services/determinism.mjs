// services/determinism — the canonical serialization spine (PRD P3).
// Every module that serializes goes through here so `build twice → byte-identical`.

// Recursively sort object keys; arrays keep their order (callers sort where order
// is not semantic). Returns a NEW value safe to JSON.stringify deterministically.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = Object.create(null); // null-proto: an own "__proto__" key is data to copy, not a prototype write
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

// Canonical JSON string (stable key order). The one true serializer.
export function canonicalJSON(value, indent = 2) {
  return JSON.stringify(canonicalize(value), null, indent);
}

// Quantize a coordinate to a fixed grid so float layout output is byte-stable.
export function quantize(n, grid = 1) {
  return Math.round(n / grid) * grid;
}

// Total order for git-like records: by a primary key, then a tiebreaker id.
export function totalOrder(a, b, primary, tiebreak) {
  if (a[primary] !== b[primary]) return a[primary] < b[primary] ? -1 : 1;
  return a[tiebreak] < b[tiebreak] ? -1 : a[tiebreak] > b[tiebreak] ? 1 : 0;
}
