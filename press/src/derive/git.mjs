// derive/git — temporal layers from git history (M4): churn hotspots, dormancy,
// and size-normalized temporal coupling (Tornhill). Build-time, zero-dep (spawns
// `git log`). Returns null if not a git repo / no history. NOT part of the
// determinism guarantee (history changes over time). Gated: opt-in via
// _config.json `temporal.enabled`, since signal is thin below ~200 commits.
import { execFileSync } from "child_process";
import { parseDate } from "../services/dates.mjs";

const DAY = 86400000;
const DEFAULT_EXCLUDE = ["index.md", "log.md", "Health", "Evolution"]; // structurally-hot / generated

export function deriveGit({ cwd, pathspec = "docs", exclude = DEFAULT_EXCLUDE, now = null } = {}) {
  let out;
  try {
    // -z: NUL-terminate the format record AND every --name-only path. Line-delimited parsing
    // corrupts on a filename containing a newline (git renders such paths verbatim with -z);
    // %x1f field-separates the header so a subject with `|` or `@@@` can't be misparsed either.
    out = execFileSync("git", ["-C", cwd, "log", "--no-merges", "-z", "--name-only", "--format=@@@%H%x1f%ct%x1f%s", "--", pathspec],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }

  // Tokenize on NUL. A token starting with `@@@` is a commit header (fields split by \x1f); any
  // other token is a file path (the first file of each commit carries a leading \n from the format
  // newline — strip only that). Paths are otherwise opaque, so newlines in them survive intact.
  const commits = [];
  let cur = null;
  for (const tokRaw of out.split("\0")) {
    if (!tokRaw) continue;
    if (tokRaw.startsWith("@@@")) {
      if (cur && cur.files.length) commits.push(cur);
      const [sha, ct, ...rest] = tokRaw.slice(3).split("\x1f");
      cur = { sha, ct: +ct, subject: (rest.join("\x1f") || "").trim(), files: [] };
    } else if (cur) {
      const f = tokRaw.replace(/^\n/, "");
      if (!f) continue;
      const base = f.split("/").pop();
      if (!exclude.some((x) => base === x || f === x)) cur.files.push(f); // exact match, not substring
    }
  }
  if (cur && cur.files.length) commits.push(cur);
  if (!commits.length) return null;
  commits.sort((a, b) => (a.ct !== b.ct ? a.ct - b.ct : a.sha < b.sha ? -1 : 1)); // total order

  const churn = {}, last = {};
  for (const c of commits) for (const f of c.files) { churn[f] = (churn[f] || 0) + 1; last[f] = Math.max(last[f] || 0, c.ct); }

  const cmp = (k) => (a, b) => b[k] - a[k] || (a.file < b.file ? -1 : 1);
  const hotspots = Object.entries(churn).map(([file, commits]) => ({ file, commits })).sort(cmp("commits")).slice(0, 10);

  const np = parseDate(now); // epoch-safe: ts can be 0 for 1970-01-01, so test .valid not truthiness
  const nowTs = np.valid ? np.ts : commits[commits.length - 1].ct * 1000;
  const dormant = Object.entries(last).map(([file, ts]) => ({ file, days: Math.floor((nowTs - ts * 1000) / DAY) })).sort(cmp("days")).slice(0, 10);

  // size-normalized co-change: each commit contributes 1/|files| to each pair it co-touches
  const pair = {};
  for (const c of commits) {
    const fs = [...new Set(c.files)].sort();
    const w = 1 / fs.length;
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
      const k = fs[i] + "\0" + fs[j]; // NUL is the one byte a path cannot contain (a newline can)
      pair[k] = (pair[k] || 0) + w;
    }
  }
  const coupling = Object.entries(pair)
    .map(([k, score]) => { const [a, b] = k.split("\0"); return { a, b, score: Math.round(score * 1000) / 1000 }; })
    .filter((p) => p.score > 0.5)
    .sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : 1))
    .slice(0, 10);

  // ── commit grouping: cluster commits that touch overlapping files into "threads"
  //    (connected components, Jaccard(files) ≥ 0.34). O(n²) — cap at the last 500. ──
  const recent = commits.slice(-500);
  const parent = recent.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < recent.length; i++) {
    const A = new Set(recent[i].files);
    for (let j = i + 1; j < recent.length; j++) {
      let inter = 0; for (const f of recent[j].files) if (A.has(f)) inter++;
      const uni = A.size + recent[j].files.length - inter;
      if (uni > 0 && inter / uni >= 0.34) parent[find(i)] = find(j);
    }
  }
  const buckets = {};
  recent.forEach((c, i) => { const r = find(i); (buckets[r] = buckets[r] || []).push(c); });
  const oneline = (c) => ({ sha: c.sha.slice(0, 7), date: new Date(c.ct * 1000).toISOString().slice(0, 10), subject: c.subject, files: c.files.length });
  const threads = Object.values(buckets)
    .filter((g) => g.length >= 2)
    .map((g) => ({ size: g.length, commits: g.sort((a, b) => a.ct - b.ct).map(oneline) }))
    .sort((a, b) => b.size - a.size || (a.commits[0].sha < b.commits[0].sha ? -1 : 1));

  return {
    commitCount: commits.length, fileCount: Object.keys(churn).length,
    hotspots, dormant, coupling, threads,
    log: commits.slice(-40).reverse().map(oneline), // newest-first oneline log
  };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// CSV-safe field (quote if it contains a comma/quote/newline)
function csvField(s) {
  const v = String(s == null ? "" : s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function renderTemporalHtml(git) {
  let b = '<article data-generated="evolution"><h1>Evolution</h1>';
  b += "<blockquote><p>Temporal signal from git (build-time · non-deterministic · grows with history). " +
    git.commitCount + " commits touched " + git.fileCount + " documents.</p></blockquote>";

  if (git.hotspots.length) {
    b += "<h2>Hotspots (changed most often)</h2>";
    const csv = "file,changes\n" + git.hotspots.map((h) => csvField(h.file) + "," + h.commits).join("\n");
    b += '<div class="viz" data-type="chart" data-kind="bar" data-format="csv">' + esc(csv) + "</div>";
  }
  if (git.coupling.length) {
    b += "<h2>Temporal coupling (often change together — hidden dependencies)</h2>";
    b += '<table class="wb-table"><thead><tr><th>A</th><th>B</th><th class="num">Strength</th></tr></thead><tbody>' +
      git.coupling.map((c) => "<tr><td><code>" + esc(c.a) + "</code></td><td><code>" + esc(c.b) + '</code></td><td class="num">' + c.score + "</td></tr>").join("") +
      "</tbody></table>";
  }
  if (git.threads && git.threads.length) {
    b += "<h2>Commit threads (groups of commits that change together)</h2>";
    git.threads.slice(0, 8).forEach((t, i) => {
      b += "<h3>Thread " + (i + 1) + " · " + t.size + " commits</h3><ul>" +
        t.commits.map((c) => "<li><code>" + esc(c.sha) + "</code> " + esc(c.date) + " " + esc(c.subject) + "</li>").join("") + "</ul>";
    });
  }
  if (git.log && git.log.length) {
    b += "<h2>Commit log (latest " + git.log.length + ")</h2>";
    b += '<table class="wb-table"><thead><tr><th>SHA</th><th>Date</th><th>Subject</th><th class="num">Files</th></tr></thead><tbody>' +
      git.log.map((c) => "<tr><td><code>" + esc(c.sha) + "</code></td><td>" + esc(c.date) + "</td><td>" + esc(c.subject) + '</td><td class="num">' + c.files + "</td></tr>").join("") +
      "</tbody></table>";
  }
  if (git.dormant.length) {
    b += "<h2>Dormant (untouched longest)</h2>";
    b += '<table class="wb-table"><thead><tr><th>Document</th><th class="num">Days</th></tr></thead><tbody>' +
      git.dormant.map((d) => "<tr><td><code>" + esc(d.file) + '</code></td><td class="num">' + d.days + "</td></tr>").join("") +
      "</tbody></table>";
  }
  return b + "</article>";
}
