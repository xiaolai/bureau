// maintain/doctor — turn health findings into an actionable repair plan, and apply
// the SAFE deterministic subset (drift count; high-confidence dangling-link typos).
// Judgment-needing findings (orphan/contradiction/stale/invalidDate/schema) are
// surfaced as advice for the author or the maintainer agent — never auto-changed.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { rewriteWikiRef } from "../core/parse.mjs";

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// nearest title by edit distance; `unique` is false when two+ titles tie for the
// minimum (so an auto-fix never silently rewrites to an arbitrary one of them).
function closest(target, titles) {
  let best = null, ties = 0;
  for (const t of titles) {
    const d = levenshtein(target, t);
    if (best === null || d < best.dist) { best = { title: t, dist: d }; ties = 1; }
    else if (d === best.dist) ties++;
  }
  return best && { title: best.title, dist: best.dist, unique: ties === 1 };
}

export function buildRepairPlan(model, health) {
  const titles = Object.keys(model.nodes);
  const fixes = [];
  for (const d of health.dangling) {
    const c = titles.length ? closest(d.target, titles) : null;
    const thresh = Math.max(1, Math.floor(d.target.length * 0.34));
    const suggest = c && c.dist <= thresh ? c.title : null;
    // auto-apply only a unique, distance-1 suggestion — a tie is ambiguous, leave it for the author
    fixes.push({ kind: "dangling", source: d.source, target: d.target, suggest, dist: c ? c.dist : null, auto: !!suggest && c.dist <= 1 && c.unique });
  }
  for (const dr of health.drift) fixes.push({ kind: "drift", declared: dr.declared, actual: dr.actual, auto: true });
  for (const o of health.orphan) fixes.push({ kind: "orphan", node: o.node, auto: false, advice: "add a [[wiki-link]] to connect it, or confirm it is truly standalone" });
  for (const x of health.contradiction) fixes.push({ kind: "contradiction", a: x.a, b: x.b, auto: false, advice: "author decides: keep which / merge" });
  for (const s of health.stale) fixes.push({ kind: "stale", node: s.node, auto: false, advice: "revisit - neighbor " + s.newerNeighbor + " was updated" });
  for (const i of health.invalidDate) fixes.push({ kind: "invalidDate", node: i.node, value: i.updated, auto: false, advice: "fix to a valid YYYY-MM-DD" });
  for (const sc of health.schema) fixes.push({ kind: "schema", node: sc.node, key: sc.key, why: sc.kind, auto: false, advice: "adjust the _types schema or the document" });
  return fixes;
}

// apply only the auto-safe fixes; returns a list of what was changed.
export function applySafe(docsDir, fixes, model) {
  const applied = [];
  const drift = fixes.find((f) => f.kind === "drift");
  if (drift) {
    const cfg = join(docsDir, "_config.json");
    const c = JSON.parse(readFileSync(cfg, "utf8"));
    c.meta = c.meta || {};
    c.meta.expectedDocs = drift.actual;
    writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    applied.push("drift: expectedDocs → " + drift.actual);
  }
  for (const f of fixes.filter((x) => x.kind === "dangling" && x.auto)) {
    const node = model.nodes[f.source];
    if (!node) continue;
    const p = join(docsDir, node.file);
    const raw = readFileSync(p, "utf8");
    const { html: next, count } = rewriteWikiRef(raw, f.target, f.suggest);
    if (count > 0 && next !== raw) { writeFileSync(p, next); applied.push("dangling: " + f.source + " [[" + f.target + "]] → [[" + f.suggest + "]]"); }
  }
  return applied;
}

export function renderRepairText(fixes, applied) {
  const lines = ["gazette doctor — repair plan"];
  if (!fixes.length) return lines.concat("  ✅ nothing to fix").join("\n");
  for (const f of fixes) {
    if (f.kind === "dangling") lines.push("  " + (f.auto ? "->auto" : f.suggest ? "?suggest" : ".pending") + " dangling " + f.source + " [[" + f.target + "]]" + (f.suggest ? " => [[" + f.suggest + "]] (dist " + f.dist + ")" : ""));
    else if (f.kind === "drift") lines.push("  ->auto ledger: declared " + f.declared + " ≠ actual " + f.actual);
    else lines.push("  .pending " + f.kind + " " + (f.node || f.a + "×" + f.b) + " — " + (f.advice || ""));
  }
  if (applied && applied.length) lines.push("", "applied " + applied.length + " items: ", ...applied.map((a) => "  ✓ " + a));
  return lines.join("\n");
}
