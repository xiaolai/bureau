// core/types — parse `docs/_types/<name>.html` schemas (the typed-relation starter,
// PRD D2 / mdbase-style). A schema declares, for docs of a given group, which typed
// edges and scalar fields are allowed/required/single-valued. Absent ⇒ everything
// untyped (health degrades gracefully).
//
// Schema frontmatter:
//   applies:  <group-id>          # the doc group this schema governs
//   edges:    [allies, contradicts]   # allowed typed-edge keys
//   fields:   [status, faction]   # allowed scalar attribute keys
//   required: [status]            # keys that must be present
//   single:   [status]            # keys that must be single-valued (a list → violation)
import { readFileSync } from "fs";
import { join } from "path";
import { splitFrontmatter } from "./parse.mjs";

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

// rich schemas (Sets) for the linter, keyed by `applies` (group id)
export function loadTypes(typesDir, typeFiles) {
  const schemas = Object.create(null); // null-proto: a type whose `applies` is an inherited key must index as data
  for (const f of typeFiles) {
    const { frontmatter: fm } = splitFrontmatter(readFileSync(join(typesDir, f), "utf8"));
    if (!fm || !fm.applies) continue;
    schemas[String(fm.applies)] = {
      applies: String(fm.applies),
      edges: new Set(asList(fm.edges)),
      fields: new Set(asList(fm.fields)),
      required: asList(fm.required),
      single: new Set(asList(fm.single)),
      file: f,
    };
  }
  return schemas;
}

// plain, JSON-serializable form for the canonical model
export function typesPlain(schemas) {
  const out = {};
  for (const [k, s] of Object.entries(schemas)) {
    out[k] = { applies: s.applies, edges: [...s.edges].sort(), fields: [...s.fields].sort(), required: [...s.required].sort(), single: [...s.single].sort() };
  }
  return out;
}
