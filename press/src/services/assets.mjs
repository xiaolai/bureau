// services/assets — bundle-budget accounting (plan §8). Sums the emitted artifact's
// bytes and flags when it exceeds a budget, so the offline bundle can't balloon
// unnoticed as view libraries are added (graph/charts later).
import { readdirSync, lstatSync } from "fs";
import { join } from "path";

const DEFAULT_BUDGET = 8 * 1024 * 1024; // 8 MB — mermaid alone is ~3.3MB; headroom for graph/charts

function walk(dir) {
  let total = 0;
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // lstat, not stat: never follow a symlink out of the output tree (or into a symlink loop) —
    // the budget accounts for the bytes actually shipped, which are real files under outDir.
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { const r = walk(p); total += r.total; files.push(...r.files); }
    else if (st.isFile()) { total += st.size; files.push({ path: p, bytes: st.size }); }
  }
  return { total, files };
}

export function bundleReport(outDir, budget = DEFAULT_BUDGET) {
  const { total, files } = walk(outDir);
  const heaviest = files.sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  return { totalBytes: total, budget, over: total > budget, heaviest };
}
