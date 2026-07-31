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
// TRANSACTIONAL: `sync` first VALIDATES the entire desired state (planIssues — the same rules `check`
// enforces) and aborts before writing ANYTHING if the plan is invalid, so a failure never leaves
// partial materialization. Individual writes are atomic (temp file + rename).
//
//   node crew.mjs list | enable <name> [--workspace <ws>] | new <name> [--role "…"] [--workspace <ws>]
//                | disable <name> [--purge] | update <name>|--all [--check] | sync | check
//
// A SHIPPED member records `upstream` tracking in its crew.json at enable time (frozen substitution
// bindings + a per-file sha of the accepted base). `update` re-substitutes the current shipped
// template and does a conservative FILE-LEVEL 3-way merge against that base: it advances files only
// upstream changed, preserves files only the user changed, and refuses on any both-sides conflict.
//
// Safe: process.cwd() is the repo; idempotent; never writes/deletes outside the repo.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, cpSync, realpathSync } from "fs";
import { join, dirname, sep, relative } from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";

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
// atomic write: stage to a RANDOMLY-named sibling temp then rename (atomic within one dir/filesystem),
// so a crash mid-write can't leave a truncated target. The `wx` flag (O_CREAT|O_EXCL) refuses to write
// through a pre-existing file OR symlink, so an attacker can't pre-plant `<target>.tmp` as a symlink to
// escape the repo; randomizing the name also stops concurrent writers colliding. A stray temp on
// failure is cleaned in finally.
const write = (p, data) => {
  if (!contained(p)) die("refusing to write outside the repo: " + p);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${randomBytes(6).toString("hex")}.bureau-tmp`;
  try { writeFileSync(tmp, data, { flag: "wx" }); renameSync(tmp, p); }
  catch (e) {
    // clean up ONLY our own partial temp: an EEXIST means `wx` refused a pre-existing file/symlink we
    // did not create, so leave it untouched; any other failure means we created tmp → remove it.
    if (e && e.code !== "EEXIST") safe(() => rmSync(tmp, { force: true }), null);
    throw e;
  }
};
const mkdirSafe = (p) => { if (!contained(p)) die("refusing to create a dir outside the repo: " + p); mkdirSync(p, { recursive: true }); };
const safeRm = (p) => { if (existsSync(p) && contained(p)) { rmSync(p, { recursive: true, force: true }); return true; } return false; };
// remove a path by its LOCATION (the link itself), not its target — for deleting a copied symlink
// whose target may point outside the repo. Guard on the PARENT dir being inside the repo.
const rmLink = (p) => { const root = safe(() => realpathSync(REPO), REPO); const par = safe(() => realpathSync(dirname(p)), null); if (par && (par === root || par.startsWith(root + sep))) safe(() => rmSync(p, { force: true }), null); };
const requireBureauMd = () => { if (!existsSync(BUREAU_MD)) die("no BUREAU.md at the repo root — run `bureau:init` first"); };
// the ONE token-substitution rule, shared by installTemplate (at enable) and update's upstream
// reconstruction (later), so the two produce byte-identical output for the same bindings. NAME +
// WORKSPACE everywhere; ROLE only in prose (never crew.json); a null role → "".
const applyTokens = (text, name, ws, role, isCrewJson) => { let s = text.split("{{NAME}}").join(name).split("{{WORKSPACE}}").join(ws); if (!isCrewJson) s = s.split("{{ROLE}}").join(role == null ? "" : role); return s; };

// ── the bureau:gen marker (ownership + drift live HERE, not in filenames) ────────
function genMarker(srcRel, content) {
  const marker = `<!-- bureau:gen source=${srcRel} sha256=${sha(content)} — generated from the bureau/crew source; edit the source, then run \`bureau:crew sync\`. Do not edit here. -->\n`;
  const m = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  return m ? m[1] + marker + (m[2].startsWith("\n") ? m[2] : "\n" + m[2]) : marker + content;
}
// strict parse: a bureau-owned file declares `source=bureau/crew/<member>/…`. Substring-only never counts.
const GEN_RE = /<!-- bureau:gen source=(bureau\/crew\/([a-z][a-z0-9-]*)\/\S+) sha256=([0-9a-f]{64}) /;
function genInfo(file) { const m = safe(() => readText(file).match(GEN_RE), null); return m ? { source: m[1], owner: m[2] } : null; }

// ── agent-frontmatter reader ─────────────────────────────────────────────────────
// SAME grammar as test/static/check.mjs's leadingFrontmatter, so the engine and the static check
// agree on what a valid agent.md is. A structural key-extractor, NOT a full YAML validator: block
// scalars / indented blocks / lists are consumed as opaque values (Claude agent frontmatter uses
// `description: |`, which press's canon parser rejects — so this, not that, is the right reader). It
// REJECTS: a top-level line that is neither `key: value`, a comment, nor blank; a non-identifier key;
// a duplicate key; a dangling indented/list line owned by no key. Returns { fm, error }.
const FM_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FM_BLOCK_SCALAR = /^[|>][+-]?[0-9]*[+-]?\s*(#.*)?$/;
function leadingFrontmatter(s) {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(s);
  if (!m) return { fm: null, error: null };
  const o = Object.create(null); // null-proto: a `__proto__:` key is data, not a prototype mutation
  const bad = (why, line) => ({ fm: null, error: `${why}: "${String(line).trim()}"` });
  const lines = m[1].split("\n");
  const indentedOrBlank = (l) => l != null && (l.trim() === "" || /^\s/.test(l) || /^-[ \t]/.test(l));
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;
    if (/^\s/.test(line) || /^-\s/.test(line)) return bad("dangling indented/list line (no owning key)", line);
    const i = line.indexOf(":");
    if (i < 0) return bad("frontmatter line is not `key: value`", line);
    const key = line.slice(0, i).trim();
    if (!FM_KEY.test(key)) return bad("unsupported frontmatter key", line);
    if (Object.prototype.hasOwnProperty.call(o, key)) return { fm: null, error: `duplicate frontmatter key "${key}"` };
    const inline = line.slice(i + 1).trim();
    if (FM_BLOCK_SCALAR.test(inline) || inline === "") {
      const block = [];
      while (indentedOrBlank(lines[li + 1])) block.push(lines[++li]);
      o[key] = block.join("\n").trim() || (inline ? inline : "");
    } else o[key] = inline;
  }
  return { fm: o, error: null };
}
// a frontmatter `name:` is a single-line slug: optional MATCHING quotes (the `\1` backreference rejects
// a mismatched pair like `"x'`) and an optional trailing YAML inline comment. Capture group 2 is the slug.
const NAME_SCALAR = /^\s*(["']?)([a-z][a-z0-9-]*)\1\s*(?:#.*)?$/;
const nameSlug = (v) => { const m = NAME_SCALAR.exec(String(v == null ? "" : v)); return m ? m[2] : null; };
// a description is "missing" if it has no usable content. Needs the RAW agent text because the parser
// collapses block and inline scalars to the same string: a block scalar (`description: |`/`>`) is real
// content unless empty, while an inline scalar is missing when empty or a YAML null (`null`/`~`,
// tolerating a trailing inline comment). Shared by both validators so they can't drift.
const descMissing = (rawAgent, fm) => {
  const fmBlock = (/^---\n([\s\S]*?)\n---/.exec(rawAgent) || [, ""])[1];
  const v = String(fm.description == null ? "" : fm.description);
  if (/^description:\s*[|>]/m.test(fmBlock)) return !v.trim();     // block scalar: missing only if empty
  const t = (v.includes("\n") ? v : v.replace(/\s+#.*$/, "")).trim(); // inline: null/~ (with optional comment) is missing
  return !t || t === "null" || t === "~";
};

// ── member model ───────────────────────────────────────────────────────────────
function rawMemberDirs() { return existsSync(SRC) ? readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []; }
function members() { // valid installed members: SAFE name + a parseable crew.json
  return rawMemberDirs().filter((n) => SAFE.test(n) && existsSync(join(SRC, n, "crew.json")))
    .map((n) => { const meta = safe(() => JSON.parse(readText(join(SRC, n, "crew.json"))), null); return { name: n, dir: join(SRC, n), meta: meta || {}, metaOk: meta != null }; })
    .filter((m) => m.metaOk);
}
const isEnabled = (m) => m.meta.enabled !== false;
const skillNames = (m) => { const d = join(m.dir, "skills"); return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && SAFE.test(e.name)).map((e) => e.name).sort() : []; };
// marker-based: a workspace is any dir carrying a bureau.json — including one NAMED `bureau`
// (the contained layout, where crew/ nests inside it). `crew`/`gazette`/`board` never carry a
// marker (init rejects them as workspace names) and are excluded defensively.
const workspaceHits = () => safe(() => readdirSync(REPO, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["crew", "gazette", "board"].includes(e.name) && existsSync(join(REPO, e.name, "bureau.json"))).map((e) => e.name), []);
// resolve the workspace name to substitute into {{WORKSPACE}}: an explicit --workspace wins (but must
// name a REAL workspace when any exist — else a typo silently mis-grounds the agent); else the single
// marker-carrying dir; 0 found ⇒ the conventional `canon` default (a fresh scaffold, before init);
// >1 found ⇒ AMBIGUOUS, so fail loud with the candidates rather than silently guessing `canon`.
function resolveWorkspace(explicit) {
  const hits = workspaceHits();
  if (explicit != null) {
    if (!SAFE.test(explicit)) die(`bad --workspace "${explicit}" — must match ${SAFE}`);
    if (hits.length && !hits.includes(explicit)) die(`--workspace "${explicit}" is not a workspace in this repo (found: ${hits.join(", ")})`);
    return explicit;
  }
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return "canon";
  die(`ambiguous workspace: ${hits.length} found (${hits.join(", ")}). Pass --workspace <name> to pick one.`);
}

// every regular file under a dir, as repo-relative paths (skips symlinks defensively).
function filesUnder(dir) { const out = []; const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { const p = join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) w(p); else if (e.isFile()) out.push(p); } }; if (existsSync(dir)) w(dir); return out; }

// expected materialized bytes for one source file (SKILL.md/agent.md get the marker; others verbatim).
function expectedAgent(m) { return genMarker(`bureau/crew/${m.name}/agent.md`, readText(join(m.dir, "agent.md"))); }
function expectedSkillFile(m, s, rel) { const srcAbs = join(m.dir, "skills", s, rel); const raw = readFileSync(srcAbs); return rel === "SKILL.md" ? Buffer.from(genMarker(`bureau/crew/${m.name}/skills/${s}/SKILL.md`, raw.toString("utf8"))) : raw; }

// materialized skill dir slugs must be unique across (member, skill) pairs. Both names are kebab
// (may contain '-'), so `${member}-${skill}` is NOT injective: member `a`+skill `b-c` and member
// `a-b`+skill `c` both yield `a-b-c`. Detect that up front and fail loud, rather than let the second
// member silently lose the write to the first's ownership marker with a confusing "refusing to
// overwrite" message. Returns a list of human-readable collision descriptions (empty when clean).
function skillCollisions(enabled) {
  const seen = new Map(), collisions = [];
  for (const m of enabled) for (const s of skillNames(m)) {
    const slug = `${m.name}-${s}`, pair = `${m.name}/${s}`;
    if (seen.has(slug) && seen.get(slug) !== pair) collisions.push(`.claude/skills/${slug}/ ← ${seen.get(slug)} and ${pair}`);
    else seen.set(slug, pair);
  }
  return collisions;
}

// a materialized target is safe to (over)write only if it's ABSENT or already bureau-owned by THIS
// member (its bureau:gen marker names it). A file with no marker is user-authored — never clobber it.
function ownedByOrAbsent(target, owner) {
  if (!existsSync(target)) return true;
  const gi = genInfo(target);
  return !!gi && gi.owner === owner;
}
// a materialized skill dir is ours ONLY if it already holds an OWNED SKILL.md. An existing dir with no
// SKILL.md (or a foreign one) is user territory — never write into / stale-clean a dir bureau didn't
// generate. (ownedByOrAbsent alone treats a missing SKILL.md as "absent → OK".)
function skillDirIsOurs(to, owner) { return !existsSync(to) || (existsSync(join(to, "SKILL.md")) && ownedByOrAbsent(join(to, "SKILL.md"), owner)); }

// ── plan validation: is the DESIRED state (sources + intended targets) internally valid? ─────────
// The SINGLE source of truth for "what a valid crew is", shared by `sync` (which aborts before ANY
// write when this returns issues, so a failure can't leave partial materialization) and `check`
// (which reports these PLUS materialized-parity). Pure: reads only, writes nothing.
function planIssues() {
  const issues = [];
  // malformed member dirs: a dir that HAS a crew.json but an unsafe name or unparseable JSON is a
  // broken member the author clearly intended — surface it, never silently skip.
  for (const n of rawMemberDirs()) {
    if (!existsSync(join(SRC, n, "crew.json"))) continue;
    if (!SAFE.test(n)) issues.push(`bureau/crew/${n}: unsafe member dir name (must match ${SAFE})`);
    else if (safe(() => JSON.parse(readText(join(SRC, n, "crew.json"))), null) == null) issues.push(`bureau/crew/${n}/crew.json: invalid JSON`);
  }
  const enabled = members().filter(isEnabled);
  for (const c of skillCollisions(enabled)) issues.push(`skill dir collision — ${c} — rename a member or skill so their 'member-skill' slugs differ`);
  for (const m of enabled) {
    // crew.json name, when present, must match the dir (the dir IS the identity; a mismatched
    // crew.json name is misleading dead metadata).
    if (m.meta.name != null && m.meta.name !== m.name) issues.push(`${m.name}: crew.json name "${m.meta.name}" != member dir "${m.name}"`);
    // agent.md: present, well-formed frontmatter, name (unquoted) == dir, has a description. The
    // frontmatter name IS the subagent's registered invocation name; if it differs from the member dir
    // (the filename and the brief's @import target) the agent registers under the wrong name.
    const agentSrc = join(m.dir, "agent.md");
    if (!existsSync(agentSrc)) issues.push(`${m.name}: source agent.md missing`);
    else {
      const rawAgent = readText(agentSrc);
      const { fm, error } = leadingFrontmatter(rawAgent);
      if (error) issues.push(`${m.name}: agent.md malformed frontmatter — ${error}`);
      else if (!fm) issues.push(`${m.name}: agent.md has no leading frontmatter`);
      else {
        const nm = nameSlug(fm.name);
        if (!nm) issues.push(`${m.name}: agent.md frontmatter has no valid name`);
        else if (nm !== m.name) issues.push(`${m.name}: agent.md frontmatter name "${nm}" != member dir "${m.name}" — the subagent would register under the wrong name`);
        if (descMissing(rawAgent, fm)) issues.push(`${m.name}: agent.md frontmatter has no description`);
      }
    }
    // brief.md: present, tokens substituted.
    const brief = join(m.dir, "brief.md");
    if (!existsSync(brief)) issues.push(`${m.name}: no brief.md`);
    else if (/\{\{[A-Z]+\}\}/.test(readText(brief))) issues.push(`${m.name}: brief.md still has an unsubstituted {{TOKEN}}`);
    // skills: every skill dir has a SAFE name and carries a SKILL.md (else Claude won't load it).
    const skillsDir = join(m.dir, "skills");
    if (existsSync(skillsDir)) for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!SAFE.test(e.name)) issues.push(`${m.name}: skill dir "${e.name}" has an unsafe name (must match ${SAFE})`);
      else if (!existsSync(join(skillsDir, e.name, "SKILL.md"))) issues.push(`${m.name}: skill "${e.name}" has no SKILL.md`);
    }
    // materialized TARGETS must be absent or already ours — validating ALL of them up front means the
    // apply phase can't materialize member A and then die on member B's user-authored collision.
    if (existsSync(join(AGENTS, m.name + ".md")) && !ownedByOrAbsent(join(AGENTS, m.name + ".md"), m.name))
      issues.push(`${m.name}: .claude/agents/${m.name}.md exists and is not bureau-generated (a user-authored agent shares this name) — rename one`);
    for (const s of skillNames(m)) if (!skillDirIsOurs(join(SKILLS, `${m.name}-${s}`), m.name))
      issues.push(`${m.name}: .claude/skills/${m.name}-${s}/ exists and is not bureau-generated (a user-authored skill shares this name) — rename one`);
  }
  return { issues, enabled };
}

// ── materialize ──────────────────────────────────────────────────────────────────
// Precondition: planIssues() was clean, so every target here is absent-or-ours. The inline guards
// stay as belt-and-suspenders (they should never fire after a clean preflight).
function materialize(m) {
  const agentTarget = join(AGENTS, m.name + ".md");
  if (!ownedByOrAbsent(agentTarget, m.name)) die(`refusing to overwrite .claude/agents/${m.name}.md — it exists and is not bureau-generated. Rename one of them.`);
  write(agentTarget, expectedAgent(m));
  for (const s of skillNames(m)) {
    const base = join(m.dir, "skills", s), to = join(SKILLS, `${m.name}-${s}`);
    if (!skillDirIsOurs(to, m.name)) die(`refusing to overwrite .claude/skills/${m.name}-${s}/ — it is not bureau-generated.`);
    const want = new Set();
    for (const abs of filesUnder(base)) { const rel = relative(base, abs); want.add(rel); write(join(to, rel), expectedSkillFile(m, s, rel)); }
    // remove materialized files no longer present in the source skill — a deleted source file must
    // not linger as an active skill. (Whole removed/disabled skill dirs are cleaned in sync().)
    if (existsSync(to)) for (const a of filesUnder(to)) { if (!want.has(relative(to, a))) safeRm(a); }
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

// ── sync (PREFLIGHT then APPLY — transactional) ────────────────────────────────────
function sync() {
  // PREFLIGHT — validate the ENTIRE desired state before writing anything. BUREAU.md must exist (the
  // brief block is rewritten into it); the plan must be clean. On any problem we abort having touched
  // NOTHING — no partial materialization, no half-written import block, no created dirs.
  requireBureauMd();
  const { issues, enabled } = planIssues();
  if (issues.length) die(`crew sync: ${issues.length} problem(s) — nothing written:\n  - ${issues.join("\n  - ")}`);
  // APPLY — every write below is now known-safe. Write generated files first, remove orphans last, so
  // an interruption leaves (harmless, check-flagged) orphans rather than a missing active artifact.
  mkdirSafe(SRC);
  const enabledSet = new Set(enabled.map((m) => m.name));
  const expectedSkillDirs = new Set(enabled.flatMap((m) => skillNames(m).map((s) => `${m.name}-${s}`)));
  for (const m of enabled) materialize(m);
  // clean ONLY bureau-generated artifacts whose owner (from the marker) is no longer enabled, or whose
  // materialized skill dir is no longer expected (a removed skill). Owner is parsed from the marker
  // source — never a filename split — so hyphenated member names are handled correctly.
  if (existsSync(AGENTS)) for (const f of readdirSync(AGENTS).sort()) { if (!f.endsWith(".md")) continue; const gi = genInfo(join(AGENTS, f)); if (gi && !enabledSet.has(gi.owner)) safeRm(join(AGENTS, f)); }
  if (existsSync(SKILLS)) for (const d of readdirSync(SKILLS).sort()) { const gi = genInfo(join(SKILLS, d, "SKILL.md")); if (gi && (!enabledSet.has(gi.owner) || !expectedSkillDirs.has(d))) safeRm(join(SKILLS, d)); }
  rewriteCrewBlock(enabled.map((m) => m.name).sort());
  return enabled;
}

// ── install a template into bureau/crew/<name>/ (symlink-safe; JSON-safe role) ───
function installTemplate(name, from, ws, role, upstreamTemplate) {
  const dest = join(SRC, name);
  if (existsSync(dest)) die(`crew member "${name}" already installed at bureau/crew/${name}/ (edit it, or disable --purge first)`);
  if (!contained(dest)) die("refusing to write outside the repo");
  if (!existsSync(from)) die(`no template at ${from}`);
  cpSync(from, dest, { recursive: true, dereference: false });
  // (copied symlinks are removed by walk() below — it lstat-checks every entry and rmLinks any
  // symlink before substitution. A separate `readdirSync(…, { recursive: true })` pass here would
  // need Node ≥ 20 for that option AND `Dirent.parentPath`, breaking the documented Node ≥ 18 floor.)
  // only the ROOT crew.json is operational (ROLE not substituted there); a nested crew.json is treated
  // like any data file — matching shippedUpstream's reconstruction, so the base can't spuriously differ.
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (safe(() => lstatSync(p).isSymbolicLink(), false)) { rmLink(p); continue; } if (e.isDirectory()) walk(p); else if (/\.(md|json)$/.test(e.name)) write(p, applyTokens(readText(p), name, ws, role, relative(dest, p) === "crew.json")); } };
  walk(dest);
  // crew.json: set name/role/enabled programmatically so a role with quotes/newlines can't break JSON.
  const cj = join(dest, "crew.json"); const meta = safe(() => JSON.parse(readText(cj)), {});
  meta.name = name; if (role != null) meta.role = role; if (meta.enabled === undefined) meta.enabled = true;
  // record upstream tracking for a SHIPPED install: frozen bindings + a per-file sha of the just-
  // written (substituted) base, so `crew update` can 3-way-merge later upstream changes against local
  // edits. `new` (local) members pass null — no upstream to track.
  if (upstreamTemplate != null) meta.upstream = { schema: 1, template: upstreamTemplate, bindings: { NAME: name, WORKSPACE: ws, ROLE: role == null ? null : role }, base: sourceFileShas(dest) };
  write(cj, JSON.stringify(meta, null, 2) + "\n");
}

function enable(name, ws) {
  if (!SAFE.test(name)) die(`bad crew name "${name}" — must match ${SAFE}`);
  requireBureauMd();   // don't write source/materialization into a repo that isn't init'd
  const dest = join(SRC, name);
  if (!existsSync(dest)) installTemplate(name, join(PLUGIN, "crew", name), resolveWorkspace(ws), null, name);
  else { const meta = safe(() => JSON.parse(readText(join(dest, "crew.json"))), {}); meta.enabled = true; write(join(dest, "crew.json"), JSON.stringify(meta, null, 2) + "\n"); }
  const got = sync().map((m) => m.name);
  console.log(`✓ crew: enabled "${name}" — agent .claude/agents/${name}.md, brief @bureau/crew/${name}/brief.md. active: ${got.join(", ") || "(none)"}`);
}

function neu(name, role, ws) {
  if (!SAFE.test(name)) die(`bad crew name "${name}" — must match ${SAFE}`);
  requireBureauMd();
  installTemplate(name, join(PLUGIN, "crew", "_template"), resolveWorkspace(ws), role || "a bureau crew member", null);
  sync();
  console.log(`✓ crew: scaffolded local member "${name}" at bureau/crew/${name}/ and materialized it.\n  Edit bureau/crew/${name}/agent.md (the persona) + brief.md, then run \`bureau:crew sync\`.`);
}

function disable(name, purge) {
  if (!SAFE.test(name)) die(`bad crew name "${name}" — must match ${SAFE}`);
  requireBureauMd();
  const dest = join(SRC, name);
  if (!existsSync(dest)) die(`no crew member "${name}" installed`);
  if (purge) { if (!safeRm(dest)) die("refusing to delete outside the repo"); }
  else { const meta = safe(() => JSON.parse(readText(join(dest, "crew.json"))), {}); meta.enabled = false; write(join(dest, "crew.json"), JSON.stringify(meta, null, 2) + "\n"); }
  sync();
  console.log(`✓ crew: disabled "${name}"${purge ? " and purged its source" : " (source kept at bureau/crew/" + name + "/)"}.`);
}

// ── check (planIssues + materialized parity; exit 1 on any problem) ──────────────
function check() {
  const { issues, enabled } = planIssues();
  const enabledSet = new Set(enabled.map((m) => m.name));
  const expectedSkillDirs = new Set(enabled.flatMap((m) => skillNames(m).map((s) => `${m.name}-${s}`)));
  if (!existsSync(BUREAU_MD)) issues.push("no BUREAU.md at the repo root — run `bureau:init` first");
  const block = existsSync(BUREAU_MD) ? crewBlockBody(readText(BUREAU_MD)) : null;
  for (const m of enabled) {
    const agentMat = join(AGENTS, m.name + ".md"), brief = join(m.dir, "brief.md");
    // materialized parity (FULL-CONTENT, not just the marker hash) so a hand-edit is caught.
    if (existsSync(join(m.dir, "agent.md"))) {
      if (!existsSync(agentMat)) issues.push(`${m.name}: not materialized (no .claude/agents/${m.name}.md) — run sync`);
      else if (readText(agentMat) !== expectedAgent(m)) issues.push(`${m.name}: .claude/agents/${m.name}.md differs from source (stale or hand-edited) — run sync`);
    }
    // brief @import present in BUREAU.md's crew block.
    if (existsSync(brief) && (block == null || !new RegExp(`(^|\\n)\\s*@bureau/crew/${esc(m.name)}/brief\\.md\\s*(\\n|$)`).test(block)))
      issues.push(`${m.name}: brief not @import-ed inside BUREAU.md's crew block — run sync`);
    // skills parity: every expected file present + byte-equal, and NO extra files in the materialized dir.
    for (const s of skillNames(m)) {
      const base = join(m.dir, "skills", s), to = join(SKILLS, `${m.name}-${s}`);
      const want = new Set(filesUnder(base).map((a) => relative(base, a)));
      for (const rel of want) { const mat = join(to, rel); if (!existsSync(mat)) issues.push(`${m.name}: skill "${s}/${rel}" not materialized — run sync`); else if (!readFileSync(mat).equals(expectedSkillFile(m, s, rel))) issues.push(`${m.name}: skill "${s}/${rel}" differs from source — run sync`); }
      for (const a of filesUnder(to)) if (!want.has(relative(to, a))) issues.push(`${m.name}: stale extra file in materialized skill — .claude/skills/${m.name}-${s}/${relative(to, a)} — run sync`);
    }
  }
  // orphan generated artifacts (owner no longer enabled) — agents AND skills.
  if (existsSync(AGENTS)) for (const f of readdirSync(AGENTS).sort()) { if (!f.endsWith(".md")) continue; const gi = genInfo(join(AGENTS, f)); if (gi && !enabledSet.has(gi.owner)) issues.push(`orphan generated agent .claude/agents/${f} (owner "${gi.owner}" not enabled) — run sync`); }
  if (existsSync(SKILLS)) for (const d of readdirSync(SKILLS).sort()) { const gi = genInfo(join(SKILLS, d, "SKILL.md")); if (gi && (!enabledSet.has(gi.owner) || !expectedSkillDirs.has(d))) issues.push(`orphan generated skill .claude/skills/${d} — run sync`); }
  if (issues.length) { console.error(`✗ crew check: ${issues.length} issue(s)\n  - ` + issues.join("\n  - ")); process.exit(1); }
  console.log(`✓ crew check: ${enabled.length} member(s) in sync` + (enabled.length ? " (" + enabled.map((m) => m.name).join(", ") + ")" : ""));
}

// ── update (conservative file-level 3-way merge against the recorded base) ────────
// member-relative path with FORWARD slashes, so a base recorded on one OS still matches U/L keys on
// another (a native-separator key would make every file look added/deleted across platforms).
const relKey = (from, abs) => relative(from, abs).split(sep).join("/");
// per-file sha map of a member's SUBSTITUTED source, keyed by member-relative path, excluding crew.json
// (operational, never template-merged). This IS the base — sufficient for add/modify/delete
// classification without snapshotting content. Null-proto so a file literally named `__proto__` is a
// real own key, not a silent prototype write.
function sourceFileShas(dir) { const out = Object.create(null); for (const abs of filesUnder(dir)) { const rel = relKey(dir, abs); if (rel === "crew.json") continue; out[rel] = sha(readFileSync(abs)); } return out; }
// current UPSTREAM (`U`): the current shipped template, re-substituted with the frozen bindings, as a
// path→bytes map (excluding crew.json). Null when the template name is unsafe — an untrusted crew.json
// must NEVER drive a path outside PLUGIN/crew — or the shipped template no longer exists.
function shippedUpstream(templateName, b) {
  if (typeof templateName !== "string" || !SAFE.test(templateName)) return null;
  const from = join(PLUGIN, "crew", templateName);
  if (!existsSync(from)) return null;
  const U = new Map();
  for (const abs of filesUnder(from)) { const rel = relKey(from, abs); if (rel === "crew.json") continue; const raw = readFileSync(abs); U.set(rel, /\.(md|json)$/.test(rel) ? Buffer.from(applyTokens(raw.toString("utf8"), b.NAME, b.WORKSPACE, b.ROLE, false)) : raw); }
  return U;
}
function memberFiles(dir) { const M = new Map(); for (const abs of filesUnder(dir)) { const rel = relKey(dir, abs); if (rel === "crew.json") continue; M.set(rel, readFileSync(abs)); } return M; }
// remove any now-empty directories under root (e.g. a skill dir whose files upstream deleted).
function pruneEmptyDirs(root) { if (!existsSync(root)) return; for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) { const d = join(root, e.name); pruneEmptyDirs(d); if (existsSync(d) && readdirSync(d).length === 0) safeRm(d); } }
// canonical (unambiguous) string of a path→sha map, for detecting a stale base independent of key
// order. JSON-encoded so a filename containing `=`/`;` can't make two distinct maps collide.
const baseCanon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
// would APPLYING the merge produce an invalid member? An upstream release can ship something that
// breaks the member — validate the PROJECTED source (in memory) before writing a byte, so `update` is
// never itself the reason a member becomes invalid. Mirrors planIssues' per-member source checks.
function projectedMemberIssues(name, files) {
  const issues = [];
  const agent = files.get("agent.md");
  if (agent == null) issues.push("agent.md would be missing");
  else { const rawAgent = agent.toString("utf8"); const { fm, error } = leadingFrontmatter(rawAgent);
    if (error || !fm) issues.push("agent.md frontmatter would be malformed");
    else {
      const nm = nameSlug(fm.name);
      if (!nm || nm !== name) issues.push("agent.md name would not match the member dir");
      if (descMissing(rawAgent, fm)) issues.push("agent.md would have no description");
    } }
  const brief = files.get("brief.md");
  if (brief == null) issues.push("brief.md would be missing");
  else if (/\{\{[A-Z]+\}\}/.test(brief.toString("utf8"))) issues.push("brief.md would have an unsubstituted {{TOKEN}}");
  const skillDirs = new Set(); for (const p of files.keys()) { const mm = /^skills\/([^/]+)\//.exec(p); if (mm) skillDirs.add(mm[1]); }
  for (const s of skillDirs) { if (!SAFE.test(s)) issues.push(`skill dir "${s}" would have an unsafe name`); else if (!files.has(`skills/${s}/SKILL.md`)) issues.push(`skill "${s}" would have no SKILL.md`); }
  return issues;
}

// classify a member's update: compares base B (stored shas), local L, upstream U per file. Returns a
// status plus the ops (write/delete), conflicts, and blockers (upstream that would break the member).
// Pure — no writes.
function classifyUpdate(m) {
  const up = m.meta.upstream;
  if (!up || !up.base || !up.bindings || !up.template) return { status: m.meta.source === "local" ? "local" : "untracked" };
  const U = shippedUpstream(up.template, up.bindings);
  if (!U) return { status: "gone", template: up.template };
  const B = up.base, L = memberFiles(m.dir);
  const paths = [...new Set([...Object.keys(B), ...U.keys(), ...L.keys()])].sort();
  const ops = [], conflicts = [];
  for (const p of paths) {
    const inB = Object.prototype.hasOwnProperty.call(B, p), inU = U.has(p), inL = L.has(p);
    const shaU = inU ? sha(U.get(p)) : null, shaL = inL ? sha(L.get(p)) : null;
    if (inB) {
      const uSame = inU && shaU === B[p], lSame = inL && shaL === B[p];
      if (inU && uSame) { /* upstream unchanged → keep local (same / edited / deleted) */ }
      else if (inU) { // upstream changed this file
        if (inL && lSame) ops.push({ p, kind: "write" });             // upstream-only change → take it
        else if (!inL) conflicts.push({ p, kind: "upstream-modified/local-deleted" });
        else if (shaL === shaU) { /* both moved to the same content → nothing */ }
        else conflicts.push({ p, kind: "modified-both" });
      } else { // upstream deleted this file
        if (inL && lSame) ops.push({ p, kind: "delete" });            // local untouched → delete it
        else if (inL) conflicts.push({ p, kind: "upstream-deleted/local-modified" });
        // both deleted → nothing
      }
    } else { // untracked (not in base)
      if (inU && !inL) ops.push({ p, kind: "write" });                // upstream added
      else if (inU && inL && shaL !== shaU) conflicts.push({ p, kind: "added-both" });
      // local-only addition (inL, !inU) → keep
    }
  }
  const newBase = Object.create(null); for (const [p, bytes] of U) newBase[p] = sha(bytes);
  // the accepted upstream can differ from the recorded base even with ZERO file ops — both sides
  // converged to the same content, or both deleted a file. Advance the base then, or a later upstream
  // change becomes a phantom conflict against a stale base.
  const baseStale = baseCanon(newBase) !== baseCanon(B);
  // validate the PROJECTED result (only when conflict-free — a conflict blocks the update anyway).
  let blockers = [], skillSlugs = [];
  if (!conflicts.length) {
    const projected = new Map(L);
    for (const op of ops) { if (op.kind === "write") projected.set(op.p, U.get(op.p)); else if (op.kind === "delete") projected.delete(op.p); }
    blockers = projectedMemberIssues(m.name, projected);
    // cross-member/global: a projected skill's materialized slug must not collide with another enabled
    // member's, and its target must be absent-or-ours — else the post-apply sync would reject the whole
    // plan AFTER this member's source was already advanced. Catch it here, before any write.
    const projSkills = new Set(); for (const p of projected.keys()) { const mm = /^skills\/([^/]+)\//.exec(p); if (mm && SAFE.test(mm[1])) projSkills.add(mm[1]); }
    skillSlugs = [...projSkills].map((s) => `${m.name}-${s}`);
    if (projSkills.size) {
      const otherSlugs = new Set(members().filter(isEnabled).filter((x) => x.name !== m.name).flatMap((x) => skillNames(x).map((s) => `${x.name}-${s}`)));
      for (const s of projSkills) { const slug = `${m.name}-${s}`;
        if (otherSlugs.has(slug)) blockers.push(`skill "${s}" (slug ${slug}) would collide with another member's skill`);
        else if (!skillDirIsOurs(join(SKILLS, slug), m.name)) blockers.push(`skill "${s}" target .claude/skills/${slug}/ is user-authored`);
      }
    }
  }
  const status = conflicts.length ? "conflict" : blockers.length ? "blocked" : (ops.length || baseStale) ? "update" : "up-to-date";
  return { status, ops, conflicts, blockers, skillSlugs, U, newBase, up };
}

// map a raw classification to a reportable status + one-line detail.
function planUpdate(m) {
  const cls = classifyUpdate(m);
  if (cls.status === "local") return { status: "local", detail: "local member — no upstream to track", cls };
  if (cls.status === "untracked") return { status: "untracked", detail: "enabled before update tracking existed — to start tracking, re-install fresh (`disable --purge` then `enable`); this replaces the local copy with the shipped template, so back up any local edits first", cls };
  if (cls.status === "gone") return { status: "gone", detail: `shipped template "${cls.template || m.name}" is unavailable (removed, or an unsafe template name) — can't track`, cls };
  if (cls.status === "up-to-date") return { status: "up-to-date", detail: "", cls };
  if (cls.status === "conflict") return { status: "conflict", detail: cls.conflicts.map((c) => `${c.p} (${c.kind})`).join("; "), cls };
  if (cls.status === "blocked") return { status: "blocked", detail: `applying upstream would produce an invalid member — ${cls.blockers.join("; ")} (resolve manually)`, cls };
  return { status: "update", detail: cls.ops.length ? cls.ops.map((o) => `${o.kind} ${o.p}`).join(", ") : "base reconciled with upstream (no file changes)", cls };
}

function applyMemberUpdate(m, cls) {
  for (const op of cls.ops) { const abs = join(m.dir, op.p); if (op.kind === "write") write(abs, cls.U.get(op.p)); else if (op.kind === "delete") safeRm(abs); }
  pruneEmptyDirs(join(m.dir, "skills"));
  // advance the base LAST — so an interruption during the file ops leaves the (old) base intact and the
  // next `update` recomputes cleanly, rather than a base claiming files it never finished writing.
  const meta = safe(() => JSON.parse(readText(join(m.dir, "crew.json"))), {});
  meta.upstream = { schema: 1, template: cls.up.template, bindings: cls.up.bindings, base: cls.newBase };
  write(join(m.dir, "crew.json"), JSON.stringify(meta, null, 2) + "\n");
}

function update(target, check) {
  const all = members();
  let targets;
  if (target === "--all") targets = all.filter((m) => m.meta.source !== "local" || m.meta.upstream);
  else if (!target || target.startsWith("--")) die("usage: crew update <name> | --all [--check]");
  else { const m = all.find((x) => x.name === target); if (!m) die(`no crew member "${target}" installed`); targets = [m]; }
  if (!targets.length) { console.log("crew update: no shipped members to update."); return; }
  if (!check) requireBureauMd();
  // classify every target first (pure), report, then apply only the clean ones.
  const plans = targets.map((m) => ({ m, ...planUpdate(m) }));
  // batch guard (--all): two members whose PROJECTED skills map to the same materialized slug each
  // classify clean (each sees only the other's CURRENT skills), then collide at sync after both sources
  // advanced. Detect the cross-batch duplicate here and block both, before any write.
  const slugOwners = new Map();
  for (const p of plans) if (p.status === "update") for (const slug of p.cls.skillSlugs || []) { if (!slugOwners.has(slug)) slugOwners.set(slug, []); slugOwners.get(slug).push(p.m.name); }
  for (const p of plans) if (p.status === "update") { const clash = (p.cls.skillSlugs || []).filter((slug) => slugOwners.get(slug).length > 1); if (clash.length) { p.status = "blocked"; p.detail = `projected skill slug(s) ${clash.join(", ")} would collide with another member updated in this batch`; } }
  console.log(check ? "crew update — plan (no changes written):" : "crew update:");
  for (const p of plans) console.log(`  ${p.m.name}: ${p.status}${p.detail ? " — " + p.detail : ""}`);
  const stuck = plans.filter((p) => p.status === "conflict" || p.status === "blocked");
  if (check) { if (plans.some((p) => p.status === "update" || p.status === "conflict" || p.status === "blocked")) process.exit(1); return; }
  // a single-target conflict/blocker aborts with nothing written; with --all, clean members still
  // advance and the stuck ones are skipped + reported (each member is its own all-or-nothing unit).
  if (targets.length === 1 && stuck.length) die(`crew update: "${plans[0].m.name}" — ${plans[0].status}, nothing written:\n  - ${plans[0].detail}\n  Resolve the source (edit bureau/crew/${plans[0].m.name}/), then re-run.`);
  let applied = 0;
  for (const p of plans) if (p.status === "update") { applyMemberUpdate(p.m, p.cls); applied++; }
  if (applied) sync();   // re-materialize once; transactional sync validates + refuses if invalid
  if (stuck.length) die(`crew update: ${stuck.length} member(s) blocked (conflict / invalid upstream) and were skipped — resolve their sources, then re-run. Applied ${applied} other(s).`);
  console.log(applied ? `✓ crew update: ${applied} member(s) updated + re-materialized.` : "✓ crew update: everything already up-to-date.");
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
// --workspace: absent ⇒ null (auto-detect); present with a value ⇒ the value; present bare ⇒ error
// (a user who typed --workspace meant to name one, so don't silently fall back to auto-detect).
const workspaceOpt = () => { if (!flag("workspace")) return null; const v = optVal("workspace"); if (v == null) die("--workspace needs a value (e.g. --workspace canon)"); return v; };
try {
  if (cmd === "list" || !cmd) list();
  else if (cmd === "enable") { if (!arg) die("usage: crew enable <name> [--workspace <ws>]"); enable(arg, workspaceOpt()); }
  else if (cmd === "new") { if (!arg) die("usage: crew new <name> [--role \"…\"] [--workspace <ws>]"); neu(arg, optVal("role"), workspaceOpt()); }
  else if (cmd === "disable") { if (!arg) die("usage: crew disable <name> [--purge]"); disable(arg, flag("purge")); }
  else if (cmd === "update") { update(arg, flag("check")); }
  else if (cmd === "sync") { const e = sync(); console.log(`✓ crew sync: ${e.length} member(s) materialized` + (e.length ? " (" + e.map((m) => m.name).join(", ") + ")" : "")); }
  else if (cmd === "check") check();
  else die(`unknown subcommand "${cmd}" (list|enable|new|disable|update|sync|check)`);
} catch (e) { die(e.message || String(e)); }
