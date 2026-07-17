// L3 rule judges — DETERMINISTIC assertions over the workspace STATE a flow produced.
// Each returns { name, pass, detail }. These never look at the model's prose; they check what
// the plugin actually DID (files, status tiers, the board). Reused by the live harness AND by
// judges.test.mjs (which proves the judges themselves are correct, with no LLM).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GAZETTE = join(PLUGIN, "press", "bin", "gazette.mjs");

const walk = (dir, pred, acc = []) => {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, acc); else if (pred(e.name)) acc.push(p);
  }
  return acc;
};
// Parse the LEADING frontmatter block (anchored at char 0; values unquoted). Only the first
// occurrence of a key wins, so a duplicated key can't silently override the declared tier.
const frontmatter = (file) => {
  const m = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
  const o = {};
  if (m) for (const l of m[1].split("\n")) {
    const i = l.indexOf(":");
    if (i > 0 && /^[A-Za-z0-9_-]+$/.test(l.slice(0, i).trim())) {
      const k = l.slice(0, i).trim();
      if (!(k in o)) o[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return o;
};
// Cabinet pages = reviewed-canon docs. Exclude the non-cabinet drawers (logbook/lint/board), any
// `_`-prefixed segment (_types/_state/…), and the index pages — matched on PATH SEGMENTS relative to
// the workspace (via path.relative), not slash regexes, so the filter is correct on Windows paths too
// and can't be fooled by a `/logbook/` substring living OUTSIDE the workspace root.
const cabinetPages = (ws) => walk(ws, (n) => n.endsWith(".md")).filter((p) => {
  const segs = relative(ws, p).split(sep);
  const base = segs[segs.length - 1];
  if (segs.some((s) => s === "logbook" || s === "lint" || s === "board")) return false;
  if (segs.some((s) => s.startsWith("_"))) return false;
  if (base === "00-overview.md" || base === "00-logbook.md") return false;
  return true;
});

// ── judges ────────────────────────────────────────────────────────────────────
export function logbookEntryExists(ws) {
  const lb = join(ws, "logbook");
  // a logbook entry lives at logbook/YYYY/MM/<id>.md — match on relative segments, not a slash regex.
  const entries = walk(lb, (n) => n.endsWith(".md")).filter((p) => {
    const segs = relative(lb, p).split(sep);
    return segs.length >= 3 && /^\d{4}$/.test(segs[0]) && /^\d{2}$/.test(segs[1]);
  });
  if (!entries.length) return { name: "logbook-entry-exists", pass: false, detail: "no logbook/YYYY/MM/*.md entry was written" };
  // Well-formed = status:logbook + a "session <id>" title + a non-empty session field. Checked
  // across ALL entries (not just the first) so an empty/malformed file can't pass on a sibling.
  const wellFormed = entries.map((p) => frontmatter(p))
    .filter((fm) => fm.status === "logbook" && /^session \S/.test(fm.title || "") && /\S/.test(fm.session || ""));
  const ok = wellFormed.length > 0;
  return { name: "logbook-entry-exists", pass: ok, detail: ok ? `${wellFormed.length}/${entries.length} well-formed` : `entries present but none well-formed (e.g. ${JSON.stringify(frontmatter(entries[0]))})` };
}

// Scan ONLY the files `bureau:init` writes and substitutes: the workspace tree (cabinets + logbook)
// plus the top-level instruction files (BUREAU.md, CLAUDE.md). Deliberately NOT the whole repo — the
// installed plugin (under .claude/…), its own templates (which legitimately carry {{WORKSPACE}} /
// {{DATE}} / {{NAME}} tokens by design), node_modules, .git, and generated board/gazette output would
// all yield FALSE POSITIVES and waste I/O. A leftover token in init's own output is the real defect.
export function noLeftoverTokens(repoRoot, wsName = "canon") {
  const SKIP = new Set([".git", "node_modules", ".claude", "gazette", "board"]);
  const targets = [];
  const wsDir = join(repoRoot, wsName);
  if (existsSync(wsDir)) targets.push(...walk(wsDir, (n) => /\.(md|json)$/.test(n)));
  for (const f of ["BUREAU.md", "CLAUDE.md"]) { const p = join(repoRoot, f); if (existsSync(p)) targets.push(p); }
  const hits = targets.filter((p) => {
    const segs = relative(repoRoot, p).split(sep);
    if (segs.some((s) => SKIP.has(s) || s.startsWith("."))) return false; // belt-and-suspenders skip
    return /\{\{[A-Z]+\}\}/.test(readFileSync(p, "utf8"));
  });
  return { name: "no-leftover-tokens", pass: hits.length === 0, detail: hits.length ? "unsubstituted tokens in: " + hits.map((p) => relative(repoRoot, p)).join(", ") : "clean" };
}

// init writes ./BUREAU.md (substituted) AND makes CLAUDE.md @import it — the import is what binds
// the trust gate to every session. Both must hold: instructions present + substituted + content
// intact, AND CLAUDE.md actually pulls them in.
export function recallRuleInstalled(repoRoot) {
  const name = "bureau-instructions-installed";
  const f = join(repoRoot, "BUREAU.md");
  if (!existsSync(f)) return { name, pass: false, detail: "./BUREAU.md not written by init" };
  const s = readFileSync(f, "utf8");
  const claudeMd = join(repoRoot, "CLAUDE.md");
  const imported = existsSync(claudeMd) && /^\s*@BUREAU\.md\s*$/m.test(readFileSync(claudeMd, "utf8"));
  const ok = !/\{\{WORKSPACE\}\}/.test(s) && /status:/.test(s) && /canonical/.test(s) && imported;
  const why = !imported ? "CLAUDE.md does not @import BUREAU.md"
    : /\{\{WORKSPACE\}\}/.test(s) ? "{{WORKSPACE}} token left in BUREAU.md" : "expected tier content missing";
  return { name, pass: ok, detail: ok ? "BUREAU.md installed + substituted + imported by CLAUDE.md" : why };
}

// compile must create the target page at proposed/verified — NEVER canonical (only review does).
// Page-specific on purpose: the scaffold legitimately ships a human-authored canonical ADR, so
// "any canonical page" can't be the signal — we check the page compile was asked to produce.
export function compileProducedProposed(ws, title) {
  // Collect ALL pages with this title — never `.find()`. A proposed duplicate must not hide a
  // canonical duplicate (which would falsely pass the "compile never writes canonical" invariant);
  // duplicate titles are themselves a defect (gazette rejects them).
  const hits = cabinetPages(ws).map((p) => ({ p, fm: frontmatter(p) })).filter((x) => (x.fm.title || "") === title);
  if (!hits.length) return { name: "compile-produced-proposed", pass: false, detail: `page "${title}" not created by compile` };
  if (hits.length > 1) return { name: "compile-produced-proposed", pass: false, detail: `${hits.length} pages titled "${title}" (tiers: ${hits.map((x) => x.fm.status).join("/")}) — duplicate titles` };
  const status = hits[0].fm.status;
  const ok = status === "proposed" || status === "verified";
  return { name: "compile-produced-proposed", pass: ok, detail: `status=${status}` + (status === "canonical" ? " — compile must NOT write canonical (that's review)" : "") };
}

export function reviewPromotedToCanonical(ws, pageTitle) {
  const hits = cabinetPages(ws).map((p) => ({ p, fm: frontmatter(p) })).filter((x) => (x.fm.title || "") === pageTitle);
  if (!hits.length) return { name: "review-promoted-canonical", pass: false, detail: `page "${pageTitle}" not found` };
  if (hits.length > 1) return { name: "review-promoted-canonical", pass: false, detail: `${hits.length} pages titled "${pageTitle}" (tiers: ${hits.map((x) => x.fm.status).join("/")}) — duplicate titles` };
  return { name: "review-promoted-canonical", pass: hits[0].fm.status === "canonical", detail: `status=${hits[0].fm.status}` };
}

// the board must build clean: 0 dangling, 0 orphans. `gazette health` EXITS NON-ZERO on an
// unhealthy board, so we must capture its stdout even when it throws and parse the counts either
// way — otherwise the count-parse branch would be dead code on exactly the failing boards this
// judge exists to catch, and the detail would be a useless "command failed".
export function boardBuildsHealthy(repoRoot, wsName, boardName = "board") {
  try { execFileSync("node", [GAZETTE, "build", "--dir", wsName, "--out", boardName], { cwd: repoRoot, stdio: "ignore", timeout: 120000 }); }
  catch (e) { return { name: "board-builds-healthy", pass: false, detail: "gazette build failed: " + (e.message || e) }; }
  let h = "";
  try { h = execFileSync("node", [GAZETTE, "health", "--dir", wsName], { cwd: repoRoot, encoding: "utf8", timeout: 120000 }); }
  catch (e) { h = e.stdout || ""; } // non-zero exit on an unhealthy board — still has the report on stdout
  const n = (re) => Number((h.match(re) || [])[1] ?? -1);
  const dangling = n(/dangling links\s*:\s*(\d+)/), orphans = n(/orphans\s*:\s*(\d+)/);
  if (dangling < 0 || orphans < 0) return { name: "board-builds-healthy", pass: false, detail: "could not parse gazette health output" };
  const ok = dangling === 0 && orphans === 0;
  return { name: "board-builds-healthy", pass: ok, detail: `dangling=${dangling} orphans=${orphans}` };
}

// A page carries PROVENANCE iff it has a Sources/Source line tying a [[wiki-link]] to the claim (the
// convention `bureau:compile` writes: `**Sources.** [[session … ]]`), or a frontmatter `sources:` key
// whose value is a [[wiki-link]]. A bare [[link]] sitting anywhere else in prose is NOT provenance
// (BUREAU.md: cite the MINUTE that introduced the claim) — accepting any-link-anywhere is exactly the
// false positive this guards against. (Whether the linked target is a real minute vs. `[[Logbook]]`
// is the gazette health lane's job; here we require the Sources STRUCTURE, not just some link.)
function hasProvenanceLink(raw, body) {
  // body: a "Source(s)" marker followed on the SAME line by a wiki-link (compile's shape).
  if (/\bsources?\b[^\n]*\[\[[^\]]+\]\]/i.test(body)) return true;
  // frontmatter: a `sources:` key AND a wiki-link within the leading frontmatter block.
  const fmBlock = (raw.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
  if (/^\s*sources?\s*:/im.test(fmBlock) && /\[\[[^\]]+\]\]/.test(fmBlock)) return true;
  return false;
}

// Content-robust variant for the LIVE harness: the LLM picks the page title, so assert on tier +
// claim shape, not an exact title. A qualifying page is a STRUCTURED, SOURCED claim — not a bare
// substring: the keyword must appear in the BODY (below frontmatter), AND the page must carry a real
// provenance link (a Sources line, or a frontmatter `sources:` wiki-link) — see hasProvenanceLink.
// That rejects a page that merely names the keyword and happens to contain some unrelated wiki-link.
// Passes only if such a page sits at an allowed tier and none sits at a forbidden one.
export function cabinetPageAbout(ws, keyword, { allow = ["proposed", "verified"], forbid = [] } = {}) {
  const kw = keyword.toLowerCase();
  const pages = cabinetPages(ws).map((p) => {
    const raw = readFileSync(p, "utf8");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, ""); // strip leading frontmatter
    return { fm: frontmatter(p), body, raw };
  }).filter((x) => x.body.toLowerCase().includes(kw) && hasProvenanceLink(x.raw, x.body));
  if (!pages.length) return { name: "cabinet-page-about", pass: false, detail: `no cabinet page makes a sourced claim about "${keyword}"` };
  const bad = pages.find((x) => forbid.includes(x.fm.status));
  if (bad) return { name: "cabinet-page-about", pass: false, detail: `page about "${keyword}" is at forbidden tier ${bad.fm.status}` };
  const ok = pages.some((x) => allow.includes(x.fm.status));
  return { name: "cabinet-page-about", pass: ok, detail: ok ? `found at tier ${pages.map((x) => x.fm.status).join("/")}` : `page about "${keyword}" not at ${allow.join("/")}` };
}

export const RULE_JUDGES = { logbookEntryExists, noLeftoverTokens, recallRuleInstalled, compileProducedProposed, reviewPromotedToCanonical, boardBuildsHealthy, cabinetPageAbout };
