// code/scan — scan a code directory: LOC per file + a file-level import graph
// (JS/TS). The data layer for "code cartography" — understanding a large repo via
// module mass + dependencies + (reusing git) churn, not a symbol-level hairball.
import { readdirSync, lstatSync, readFileSync, existsSync } from "fs";
import { join, relative, dirname, extname } from "path";

const CODE_EXT = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "vendor"]);
// match each import construct on its own — no cross-statement [\s\S]*? span (which
// would swallow a side-effect `import "x"` that precedes a later `from`):
//   from "x"  ·  import "x"  ·  import("x")  ·  require("x")
const IMPORT_RE = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

function walk(dir, root, out) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIR.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    let st; try { st = lstatSync(p); } catch { continue; } // unreadable → skip
    if (st.isSymbolicLink()) continue;                     // don't follow links (cycles / external trees)
    if (st.isDirectory()) walk(p, root, out);
    else if (st.isFile() && CODE_EXT.has(extname(name))) out.push(p);
  }
}

// resolve a relative import to a scanned file path (try extensions + /index)
function resolveImport(spec, fromFile, fileSet) {
  if (!spec.startsWith(".")) return null; // external dep — skip
  const base = join(dirname(fromFile), spec);
  const cands = [base, ...[...CODE_EXT].map((e) => base + e), ...[...CODE_EXT].map((e) => join(base, "index" + e))];
  for (const c of cands) if (fileSet.has(c)) return c;
  return null;
}

export function scanCode({ dir }) {
  if (!existsSync(dir)) return null;
  const abs = [];
  walk(dir, dir, abs);
  if (!abs.length) return null;
  const fileSet = new Set(abs);

  const files = [];
  const edges = [];
  for (const p of abs) {
    const src = readFileSync(p, "utf8");
    const loc = src.split("\n").length;
    const rel = relative(dir, p);
    const top = rel.split(/[\\/]/)[0] || ".";
    files.push({ path: rel, loc, group: top });
    let m;
    IMPORT_RE.lastIndex = 0;
    const seen = new Set();
    while ((m = IMPORT_RE.exec(src))) {
      const target = resolveImport(m[1], p, fileSet);
      if (target && target !== p) { const tr = relative(dir, target); if (!seen.has(tr)) { seen.add(tr); edges.push({ source: rel, target: tr }); } }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  edges.sort((a, b) => (a.source + a.target < b.source + b.target ? -1 : 1));
  return { files, edges, totalLoc: files.reduce((s, f) => s + f.loc, 0), fileCount: files.length };
}

// adapt the code scan into the {nodes, edges} shape deriveLayout/graph-svg expect
export function codeModel(scan) {
  const nodes = {};
  for (const f of scan.files) nodes[f.path] = { id: f.path, title: f.path.split(/[\\/]/).pop(), group: f.group };
  return { nodes, edges: scan.edges.map((e) => ({ source: e.source, target: e.target, edgeType: null })), nodeCount: scan.files.length, meta: {} };
}
