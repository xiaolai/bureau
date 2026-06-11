// L3 rule judges — DETERMINISTIC assertions over the workspace STATE a flow produced.
// Each returns { name, pass, detail }. These never look at the model's prose; they check what
// the plugin actually DID (files, status tiers, the board). Reused by the live harness AND by
// judges.test.mjs (which proves the judges themselves are correct, with no LLM).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GAZETTE = join(PLUGIN, "gazette", "bin", "gazette.mjs");

const walk = (dir, pred, acc = []) => {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, acc); else if (pred(e.name)) acc.push(p);
  }
  return acc;
};
const frontmatter = (file) => { const m = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/); const o = {}; if (m) for (const l of m[1].split("\n")) { const i = l.indexOf(":"); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return o; };
const cabinetPages = (ws) => walk(ws, (n) => n.endsWith(".md")).filter((p) => !/\/(logbook|lint|board)\//.test(p) && !/\/_/.test(p) && !/\/00-overview\.md$|\/00-logbook\.md$/.test(p));

// ── judges ────────────────────────────────────────────────────────────────────
export function logbookEntryExists(ws) {
  const entries = walk(join(ws, "logbook"), (n) => n.endsWith(".md")).filter((p) => /\/\d{4}\/\d{2}\//.test(p));
  if (!entries.length) return { name: "logbook-entry-exists", pass: false, detail: "no logbook/YYYY/MM/*.md entry was written" };
  const fm = frontmatter(entries[0]);
  const ok = fm.status === "logbook" && /^session /.test(fm.title || "");
  return { name: "logbook-entry-exists", pass: ok, detail: ok ? `entry ${entries.length}` : `entry has bad frontmatter: ${JSON.stringify(fm)}` };
}

export function noLeftoverTokens(repoRoot) {
  const hits = walk(repoRoot, (n) => /\.(md|json)$/.test(n)).filter((p) => !/\.git\//.test(p) && /\{\{[A-Z]+\}\}/.test(readFileSync(p, "utf8")));
  return { name: "no-leftover-tokens", pass: hits.length === 0, detail: hits.length ? "unsubstituted tokens in: " + hits.join(", ") : "clean" };
}

export function recallRuleInstalled(repoRoot) {
  const p = join(repoRoot, ".claude", "rules", "bureau.md");
  if (!existsSync(p)) return { name: "recall-rule-installed", pass: false, detail: ".claude/rules/bureau.md not installed by init" };
  const s = readFileSync(p, "utf8");
  const ok = !/\{\{WORKSPACE\}\}/.test(s) && /status:/.test(s) && /canonical/.test(s);
  return { name: "recall-rule-installed", pass: ok, detail: ok ? "installed + substituted" : "token left or content missing" };
}

// compile must create the target page at proposed/verified — NEVER canonical (only review does).
// Page-specific on purpose: the scaffold legitimately ships a human-authored canonical ADR, so
// "any canonical page" can't be the signal — we check the page compile was asked to produce.
export function compileProducedProposed(ws, title) {
  const hit = cabinetPages(ws).map((p) => ({ p, fm: frontmatter(p) })).find((x) => (x.fm.title || "") === title);
  if (!hit) return { name: "compile-produced-proposed", pass: false, detail: `page "${title}" not created by compile` };
  const ok = hit.fm.status === "proposed" || hit.fm.status === "verified";
  return { name: "compile-produced-proposed", pass: ok, detail: `status=${hit.fm.status}` + (hit.fm.status === "canonical" ? " — compile must NOT write canonical (that's review)" : "") };
}

export function reviewPromotedToCanonical(ws, pageTitle) {
  const hit = cabinetPages(ws).map((p) => ({ p, fm: frontmatter(p) })).find((x) => (x.fm.title || "") === pageTitle);
  if (!hit) return { name: "review-promoted-canonical", pass: false, detail: `page "${pageTitle}" not found` };
  return { name: "review-promoted-canonical", pass: hit.fm.status === "canonical", detail: `status=${hit.fm.status}` };
}

// the board must build clean: 0 dangling, 0 orphans, exit 0.
export function boardBuildsHealthy(repoRoot, wsName, boardName = "board") {
  try {
    execFileSync("node", [GAZETTE, "build", "--dir", wsName, "--out", boardName], { cwd: repoRoot, stdio: "ignore" });
    const h = execFileSync("node", [GAZETTE, "health", "--dir", wsName], { cwd: repoRoot, encoding: "utf8" });
    const n = (re) => Number((h.match(re) || [])[1] ?? -1);
    const dangling = n(/dangling links\s*:\s*(\d+)/), orphans = n(/orphans\s*:\s*(\d+)/);
    const ok = dangling === 0 && orphans === 0;
    return { name: "board-builds-healthy", pass: ok, detail: `dangling=${dangling} orphans=${orphans}` };
  } catch (e) { return { name: "board-builds-healthy", pass: false, detail: "gazette build/health failed: " + (e.message || e) }; }
}

// Content-robust variant for the LIVE harness: the LLM picks the page title, so assert on
// tier + body content, not an exact title. Passes if SOME cabinet page at an allowed tier
// contains the keyword (case-insensitive) — and never at a forbidden tier.
export function cabinetPageAbout(ws, keyword, { allow = ["proposed", "verified"], forbid = [] } = {}) {
  const pages = cabinetPages(ws).map((p) => ({ fm: frontmatter(p), body: readFileSync(p, "utf8") }))
    .filter((x) => x.body.toLowerCase().includes(keyword.toLowerCase()));
  if (!pages.length) return { name: "cabinet-page-about", pass: false, detail: `no cabinet page mentions "${keyword}"` };
  const bad = pages.find((x) => forbid.includes(x.fm.status));
  if (bad) return { name: "cabinet-page-about", pass: false, detail: `page about "${keyword}" is at forbidden tier ${bad.fm.status}` };
  const ok = pages.some((x) => allow.includes(x.fm.status));
  return { name: "cabinet-page-about", pass: ok, detail: ok ? `found at tier ${pages.map((x) => x.fm.status).join("/")}` : `page about "${keyword}" not at ${allow.join("/")}` };
}

export const RULE_JUDGES = { logbookEntryExists, noLeftoverTokens, recallRuleInstalled, compileProducedProposed, reviewPromotedToCanonical, boardBuildsHealthy, cabinetPageAbout };
