#!/usr/bin/env node
// bureau crew engine — deterministic, no LLM. A "crew member" is a bundle authored in
// bureau/crew/<name>/ (the repo SOURCE OF TRUTH, committed) and MATERIALIZED into Claude Code's
// native project slots so Claude discovers it:
//   bureau/crew/<name>/agent.md      -> .claude/agents/<name>.md        (copy + bureau:gen marker)
//   bureau/crew/<name>/skills/<s>/   -> .claude/skills/<name>-<s>/       (recursive copy; SKILL.md marked)
//   bureau/crew/<name>/brief.md      -> loaded via BUREAU.md  @import    (no copy — read in place)
// The marker carries the SOURCE PATH + hash; ownership and drift are derived from it, never from a
// bare substring or a filename split. Every write AND delete is realpath-containment-checked.
//
//   node crew.mjs list | enable <name> | new <name> [--role "…"] | disable <name> [--purge] | sync | check
//
// Safe: process.cwd() is the repo; idempotent; never writes/deletes outside the repo.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync, cpSync, realpathSync } from "fs";
import { join, dirname, sep, relative } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");   // bureau plugin root
const REPO = process.cwd();                                          // the consuming repo
const SRC = join(REPO, "bureau", "crew");                           // per-member source dirs (visible; the press skips it)
const AGENTS = join(REPO, ".claude", "agents");
const SKILLS = join(REPO, ".claude", "skills");
const BUREAU_MD = join(REPO, "BUREAU.md");
const SAFE = /^[a-z][a-z0-9-]*$/;                                    // crew member / skill name shape

const sha = (b) => createHash("sha256").update(b).digest("hex");
const die = (m) => { console.error("✗ " + m); process.exit(1); };
const readText = (p) => readFileSync(p, "utf8");
const safe = (fn, d) => { try { return fn(); } catch { return d; } };
// realpath of the deepest EXISTING ancestor of p must sit inside REPO (symlink-safe).
const contained = (p) => {
  const root = safe(() => realpathSync(REPO), REPO);
  let a = p; while (!existsSync(a) && a !== dirname(a)) a = dirname(a);
  const real = safe(() => realpathSync(a), null);
  return !!real && (real === root || real.startsWith(root + sep));
};
const write = (p, data) => { if (!contained(p)) die("refusing to write outside the repo: " + p); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
const mkdirSafe = (p) => { if (!contained(p)) die("refusing to create a dir outside the repo: " + p); mkdirSync(p, { recursive: true }); };
const safeRm = (p) => { if (existsSync(p) && contained(p)) { rmSync(p, { recursive: true, force: true }); return true; } return false; };
// remove a path by its LOCATION (the link itself), not its target — for deleting a copied symlink
// whose target may point outside the repo. Guard on the PARENT dir being inside the repo.
const rmLink = (p) => { const root = safe(() => realpathSync(REPO), REPO); const par = safe(() => realpathSync(dirname(p)), null); if (par && (par === root || par.startsWith(root + sep))) safe(() => rmSync(p, { force: true }), null); };

// ── the bureau:gen marker (ownership + drift live HERE, not in filenames) ────────
function genMarker(srcRel, content) {
  const marker = `<!-- bureau:gen source=${srcRel} sha256=${sha(content)} — generated from the bureau/crew source; edit the source, then run \`bureau:crew sync\`. Do not edit here. -->\n`;
  const m = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  return m ? m[1] + marker + (m[2].startsWith("\n") ? m[2] : "\n" + m[2]) : marker + content;
}
// strict parse: a bureau-owned file declares `source=bureau/crew/<member>/…`. Substring-only never counts.
const GEN_RE = /<!-- bureau:gen source=(bureau\/crew\/([a-z][a-z0-9-]*)\/\S+) sha256=([0-9a-f]{64}) /;
function genInfo(file) { const m = safe(() => readText(file).match(GEN_RE), null); return m ? { source: m[1], owner: m[2] } : null; }

// ── member model ───────────────────────────────────────────────────────────────
function rawMemberDirs() { return existsSync(SRC) ? readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []; }
function members() { // valid installed members: SAFE name + a parseable crew.json
  return rawMemberDirs().filter((n) => SAFE.test(n) && existsSync(join(SRC, n, "crew.json")))
    .map((n) => { const meta = safe(() => JSON.parse(readText(join(SRC, n, "crew.json"))), null); return { name: n, dir: join(SRC, n), meta: meta || {}, metaOk: meta != null }; })
    .filter((m) => m.metaOk);
}
const isEnabled = (m) => m.meta.enabled !== false;
const skillNames = (m) => { const d = join(m.dir, "skills"); return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && SAFE.test(e.name)).map((e) => e.name).sort() : []; };
const detectWorkspace = () => { const hits = safe(() => readdirSync(REPO, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["bureau", "crew", "gazette", "board"].includes(e.name) && existsSync(join(REPO, e.name, "bureau.json"))).map((e) => e.name), []); return hits.length === 1 ? hits[0] : null; };

// every regular file under a dir, as repo-relative paths (skips symlinks defensively).
function filesUnder(dir) { const out = []; const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { const p = join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) w(p); else if (e.isFile()) out.push(p); } }; if (existsSync(dir)) w(dir); return out; }

// expected materialized bytes for one source file (SKILL.md/agent.md get the marker; others verbatim).
function expectedAgent(m) { return genMarker(`bureau/crew/${m.name}/agent.md`, readText(join(m.dir, "agent.md"))); }
function expectedSkillFile(m, s, rel) { const srcAbs = join(m.dir, "skills", s, rel); const raw = readFileSync(srcAbs); return rel === "SKILL.md" ? Buffer.from(genMarker(`bureau/crew/${m.name}/skills/${s}/SKILL.md`, raw.toString("utf8"))) : raw; }

// ── materialize ──────────────────────────────────────────────────────────────────
function materialize(m) {
  write(join(AGENTS, m.name + ".md"), expectedAgent(m));
  for (const s of skillNames(m)) {
    const base = join(m.dir, "skills", s), to = join(SKILLS, `${m.name}-${s}`);
    for (const abs of filesUnder(base)) write(join(to, relative(base, abs)), expectedSkillFile(m, s, relative(base, abs)));
  }
}

// ── BUREAU.md crew block (briefs ride the @import rail) ─────────────────────────
const OPEN = "<!-- bureau:crew -->", CLOSE = "<!-- /bureau:crew -->";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCK_RE = new RegExp(esc(OPEN) + "[\\s\\S]*?" + esc(CLOSE), "g");
function crewBlockBody(md) { const m = md.match(new RegExp(esc(OPEN) + "([\\s\\S]*?)" + esc(CLOSE))); return m ? m[1] : null; }
function rewriteCrewBlock(enabledNames) {
  if (!existsSync(BUREAU_MD)) die("no BUREAU.md — run `bureau:init` first");
  const lines = enabledNames.map((n) => `@bureau/crew/${n}/brief.md`);
  const block = `${OPEN}\n${lines.join("\n")}${lines.length ? "\n" : ""}${CLOSE}`;
  // strip EVERY existing managed block (dedupe), then append exactly one.
  const stripped = readText(BUREAU_MD).replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "");
  write(BUREAU_MD, stripped + "\n\n" + block + "\n");
}

// ── sync ─────────────────────────────────────────────────────────────────────────
function sync() {
  mkdirSafe(SRC);
  const enabled = members().filter(isEnabled);
  const enabledSet = new Set(enabled.map((m) => m.name));
  const expectedSkillDirs = new Set(enabled.flatMap((m) => skillNames(m).map((s) => `${m.name}-${s}`)));
  for (const m of enabled) materialize(m);
  // clean ONLY bureau-generated artifacts whose owner (from the marker) is no longer enabled, or
  // whose materialized skill dir is no longer expected (a removed skill). Owner is parsed from the
  // marker source — never a filename split — so hyphenated member names are handled correctly.
  if (existsSync(AGENTS)) for (const f of readdirSync(AGENTS).sort()) { if (!f.endsWith(".md")) continue; const gi = genInfo(join(AGENTS, f)); if (gi && !enabledSet.has(gi.owner)) safeRm(join(AGENTS, f)); }
  if (existsSync(SKILLS)) for (const d of readdirSync(SKILLS).sort()) { const gi = genInfo(join(SKILLS, d, "SKILL.md")); if (gi && (!enabledSet.has(gi.owner) || !expectedSkillDirs.has(d))) safeRm(join(SKILLS, d)); }
  rewriteCrewBlock(enabled.map((m) => m.name).sort());
  return enabled;
}

// ── install a template into bureau/crew/<name>/ (symlink-safe; JSON-safe role) ───
function installTemplate(name, from, ws, role) {
  const dest = join(SRC, name);
  if (existsSync(dest)) die(`crew member "${name}" already installed at bureau/crew/${name}/ (edit it, or disable --purge first)`);
  if (!contained(dest)) die("refusing to write outside the repo");
  if (!existsSync(from)) die(`no template at ${from}`);
  cpSync(from, dest, { recursive: true, dereference: false });
  for (const e of readdirSync(dest, { withFileTypes: true, recursive: true })) {
    if (typeof e.isSymbolicLink === "function" && e.isSymbolicLink()) rmLink(join(e.parentPath || e.path, e.name)); // delete the copied symlink itself (target may point outside)
  }
  // substitute safe tokens in text files (NAME/WORKSPACE everywhere; ROLE only in prose, not crew.json).
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (safe(() => lstatSync(p).isSymbolicLink(), false)) { rmLink(p); continue; } if (e.isDirectory()) walk(p); else if (/\.(md|json)$/.test(e.name)) { let s = readText(p); s = s.split("{{NAME}}").join(name).split("{{WORKSPACE}}").join(ws); if (e.name !== "crew.json") s = s.split("{{ROLE}}").join(role); write(p, s); } } };
  walk(dest);
  // crew.json: set name/role/enabled programmatically so a role with quotes/newlines can't break JSON.
  const cj = join(dest, "crew.json"); const meta = safe(() => JSON.parse(readText(cj)), {});
  meta.name = name; if (role != null) meta.role = role; if (meta.enabled === undefined) meta.enabled = true;
  write(cj, JSON.stringify(meta, null, 2) + "\n");
}

function enable(name) {
  if (!SAFE.test(name)) die(`bad crew name "${name}" — must match ${SAFE}`);
  const dest = join(SRC, name);
  if (!existsSync(dest)) installTemplate(name, join(PLUGIN, "crew", name), detectWorkspace() || "canon", null);
  else { const meta = safe(() => JSON.parse(readText(join(dest, "crew.json"))), {}); meta.enabled = true; write(join(dest, "crew.json"), JSON.stringify(meta, null, 2) + "\n"); }
  const got = sync().map((m) => m.name);
  console.log(`✓ crew: enabled "${name}" — agent .claude/agents/${name}.md, brief @bureau/crew/${name}/brief.md. active: ${got.join(", ") || "(none)"}`);
}

function neu(name, role) {
  if (!SAFE.test(name)) die(`bad crew name "${name}" — must match ${SAFE}`);
  installTemplate(name, join(PLUGIN, "crew", "_template"), detectWorkspace() || "canon", role || "a bureau crew member");
  sync();
  console.log(`✓ crew: scaffolded local member "${name}" at bureau/crew/${name}/ and materialized it.\n  Edit bureau/crew/${name}/agent.md (the persona) + brief.md, then run \`bureau:crew sync\`.`);
}

function disable(name, purge) {
  if (!SAFE.test(name)) die(`bad crew name "${name}" — must match ${SAFE}`);
  const dest = join(SRC, name);
  if (!existsSync(dest)) die(`no crew member "${name}" installed`);
  if (purge) { if (!safeRm(dest)) die("refusing to delete outside the repo"); }
  else { const meta = safe(() => JSON.parse(readText(join(dest, "crew.json"))), {}); meta.enabled = false; write(join(dest, "crew.json"), JSON.stringify(meta, null, 2) + "\n"); }
  sync();
  console.log(`✓ crew: disabled "${name}"${purge ? " and purged its source" : " (source kept at bureau/crew/" + name + "/)"}.`);
}

// ── check (verify source ↔ materialized; exit 1 on any problem) ──────────────────
function check() {
  const issues = [];
  // 1. malformed member dirs (unsafe name or invalid crew.json) — surfaced, never silently skipped.
  for (const n of rawMemberDirs()) {
    if (!existsSync(join(SRC, n, "crew.json"))) continue;
    if (!SAFE.test(n)) issues.push(`bureau/crew/${n}: unsafe member dir name (must match ${SAFE})`);
    else if (safe(() => JSON.parse(readText(join(SRC, n, "crew.json"))), null) == null) issues.push(`bureau/crew/${n}/crew.json: invalid JSON`);
  }
  const all = members(), enabled = all.filter(isEnabled), enabledSet = new Set(enabled.map((m) => m.name));
  const expectedSkillDirs = new Set(enabled.flatMap((m) => skillNames(m).map((s) => `${m.name}-${s}`)));
  const block = existsSync(BUREAU_MD) ? crewBlockBody(readText(BUREAU_MD)) : null;
  for (const m of enabled) {
    const agentSrc = join(m.dir, "agent.md"), agentMat = join(AGENTS, m.name + ".md"), brief = join(m.dir, "brief.md");
    if (!existsSync(agentSrc)) { issues.push(`${m.name}: source agent.md missing`); continue; }
    const fm = readText(agentSrc).match(/^---\n([\s\S]*?)\n---/);
    if (!fm) issues.push(`${m.name}: agent.md has no frontmatter`);
    else { if (!/\bname:/.test(fm[1])) issues.push(`${m.name}: agent.md frontmatter has no name`); if (!/\bdescription:/.test(fm[1])) issues.push(`${m.name}: agent.md frontmatter has no description`); }
    // FULL-CONTENT compare (not just the marker hash) so a hand-edit to the materialized file is caught.
    if (!existsSync(agentMat)) issues.push(`${m.name}: not materialized (no .claude/agents/${m.name}.md) — run sync`);
    else if (readText(agentMat) !== expectedAgent(m)) issues.push(`${m.name}: .claude/agents/${m.name}.md differs from source (stale or hand-edited) — run sync`);
    if (!existsSync(brief)) issues.push(`${m.name}: no brief.md`);
    else { if (/\{\{[A-Z]+\}\}/.test(readText(brief))) issues.push(`${m.name}: brief.md still has an unsubstituted {{TOKEN}}`);
      if (block == null || !new RegExp(`(^|\\n)\\s*@bureau/crew/${esc(m.name)}/brief\\.md\\s*(\\n|$)`).test(block)) issues.push(`${m.name}: brief not @import-ed inside BUREAU.md's crew block — run sync`); }
    // skills: every expected file present + byte-equal, and NO extra files in the materialized dir.
    for (const s of skillNames(m)) {
      const base = join(m.dir, "skills", s), to = join(SKILLS, `${m.name}-${s}`);
      const want = new Set(filesUnder(base).map((a) => relative(base, a)));
      for (const rel of want) { const mat = join(to, rel); if (!existsSync(mat)) issues.push(`${m.name}: skill "${s}/${rel}" not materialized — run sync`); else if (!readFileSync(mat).equals(expectedSkillFile(m, s, rel))) issues.push(`${m.name}: skill "${s}/${rel}" differs from source — run sync`); }
      for (const a of filesUnder(to)) if (!want.has(relative(to, a))) issues.push(`${m.name}: stale extra file in materialized skill — .claude/skills/${m.name}-${s}/${relative(to, a)} — run sync`);
    }
  }
  // 2. orphan generated artifacts (owner no longer enabled) — agents AND skills.
  if (existsSync(AGENTS)) for (const f of readdirSync(AGENTS).sort()) { if (!f.endsWith(".md")) continue; const gi = genInfo(join(AGENTS, f)); if (gi && !enabledSet.has(gi.owner)) issues.push(`orphan generated agent .claude/agents/${f} (owner "${gi.owner}" not enabled) — run sync`); }
  if (existsSync(SKILLS)) for (const d of readdirSync(SKILLS).sort()) { const gi = genInfo(join(SKILLS, d, "SKILL.md")); if (gi && (!enabledSet.has(gi.owner) || !expectedSkillDirs.has(d))) issues.push(`orphan generated skill .claude/skills/${d} — run sync`); }
  if (issues.length) { console.error(`✗ crew check: ${issues.length} issue(s)\n  - ` + issues.join("\n  - ")); process.exit(1); }
  console.log(`✓ crew check: ${enabled.length} member(s) in sync` + (enabled.length ? " (" + enabled.map((m) => m.name).join(", ") + ")" : ""));
}

function list() {
  const shipped = existsSync(join(PLUGIN, "crew")) ? readdirSync(join(PLUGIN, "crew"), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "_template" && existsSync(join(PLUGIN, "crew", e.name, "crew.json"))).map((e) => e.name).sort() : [];
  const installed = members(), installedNames = new Set(installed.map((m) => m.name));
  console.log("Crew");
  for (const m of installed) console.log(`  ${isEnabled(m) ? "●" : "○"} ${m.name.padEnd(14)} ${m.meta.source === "local" || !shipped.includes(m.name) ? "local " : "shipped"}  ${m.meta.role || ""}`);
  const avail = shipped.filter((n) => !installedNames.has(n));
  if (avail.length) console.log(`  available (shipped): ${avail.join(", ")}   → bureau:crew enable <name>`);
  console.log(`  author your own                                  → bureau:crew new <name>`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const [cmd, arg] = process.argv.slice(2);
const flag = (n) => process.argv.includes("--" + n);
const optVal = (n) => { const i = process.argv.indexOf("--" + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null; };
try {
  if (cmd === "list" || !cmd) list();
  else if (cmd === "enable") { if (!arg) die("usage: crew enable <name>"); enable(arg); }
  else if (cmd === "new") { if (!arg) die("usage: crew new <name> [--role \"…\"]"); neu(arg, optVal("role")); }
  else if (cmd === "disable") { if (!arg) die("usage: crew disable <name> [--purge]"); disable(arg, flag("purge")); }
  else if (cmd === "sync") { const e = sync(); console.log(`✓ crew sync: ${e.length} member(s) materialized` + (e.length ? " (" + e.map((m) => m.name).join(", ") + ")" : "")); }
  else if (cmd === "check") check();
  else die(`unknown subcommand "${cmd}" (list|enable|new|disable|sync|check)`);
} catch (e) { die(e.message || String(e)); }
