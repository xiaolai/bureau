// derive/schema — the `_types` linter. Validates each doc against its group's
// schema and returns findings (surfaced in the health report, not hard-fail — an
// evolving KB shouldn't break the board on an annotation slip). Deterministic.
//
// Kinds: unknownEdge (typed edge not in schema.edges), unknownField (attr not in
// schema.fields), missingRequired (required key absent), multiSingle (a single-
// valued field given a list).

const RESERVED_PRESENT = ["status", "type", "updated"];
const toSet = (v) => (v instanceof Set ? v : new Set(v || []));

export function lintSchema(model, types) {
  if (!types || !Object.keys(types).length) return [];
  // normalize: schemas may arrive rich (Sets, from corpus) or plain (arrays, from model.types)
  const norm = {};
  for (const [g, s] of Object.entries(types)) {
    norm[g] = { edges: toSet(s.edges), fields: toSet(s.fields), required: [...(s.required || [])], single: toSet(s.single) };
  }
  types = norm;
  const edgeTypesByNode = {};
  for (const e of model.edges) {
    if (e.edgeType == null) continue;
    (edgeTypesByNode[e.source] = edgeTypesByNode[e.source] || new Set()).add(e.edgeType);
  }

  const findings = [];
  for (const id of Object.keys(model.nodes)) {
    const node = model.nodes[id];
    const schema = types[node.group];
    if (!schema) continue;
    const used = edgeTypesByNode[id] || new Set();

    for (const k of used) if (!schema.edges.has(k)) findings.push({ kind: "unknownEdge", node: id, key: k });
    if (schema.fields.size) {
      for (const k of Object.keys(node.attrs)) if (!schema.fields.has(k)) findings.push({ kind: "unknownField", node: id, key: k });
    }
    const present = new Set([...Object.keys(node.attrs), ...used]);
    for (const k of RESERVED_PRESENT) if (node[k] != null) present.add(k);
    for (const k of schema.required) if (!present.has(k)) findings.push({ kind: "missingRequired", node: id, key: k });
    for (const k of schema.single) if (Array.isArray(node.attrs[k])) findings.push({ kind: "multiSingle", node: id, key: k });
  }
  findings.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return findings;
}
