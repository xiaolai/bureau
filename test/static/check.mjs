#!/usr/bin/env node
// L0 — static structural gate. Deterministic, free, no LLM. Fails loud (exit 1) on any defect.
// Validates: JSON parses; command/skill LEADING frontmatter blocks (required keys, parsed from
// the block — not a stray body `---`); command→skill cross-references resolve; every hook command
// references a script that exists; the gazette bundle ships; the bureau-instructions template
// keeps its substitution token.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fails = [];
const fail = (m) => fails.push(m);
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const ls = (p) => (existsSync(join(ROOT, p)) ? readdirSync(join(ROOT, p)) : []);

// Extract the LEADING YAML frontmatter block as a key→value map, or null if the file does not
// open with a properly-delimited `---\n … \n---` block. Anchored at char 0 so a `---` rule that
// appears later in the body can never be mistaken for frontmatter.
function leadingFrontmatter(s) {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(s);
  if (!m) return null;
  const o = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0 && /^\s*[A-Za-z0-9_-]+\s*$/.test(line.slice(0, i))) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

// 1. every JSON file parses.
const jsons = ["\.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "hooks/hooks.json",
  "press/package.json", "templates/workspace/_config.json", "templates/workspace/bureau.json"];
for (const j of jsons.map((s) => s.replace(/^\\\./, "."))) {
  if (!existsSync(join(ROOT, j))) { fail(`missing JSON: ${j}`); continue; }
  try { JSON.parse(read(j)); } catch (e) { fail(`invalid JSON ${j}: ${e.message}`); }
}

// 2. commands: a LEADING frontmatter block carrying a non-empty description.
for (const f of ls("commands").filter((f) => f.endsWith(".md"))) {
  const fm = leadingFrontmatter(read(`commands/${f}`));
  if (!fm) fail(`commands/${f}: no leading frontmatter block`);
  else if (!fm.description) fail(`commands/${f}: no description in frontmatter`);
}

// 3. skills: a LEADING frontmatter block with name (matching the dir) + description; ≥1 <example>
//    and a Scope note in the body.
for (const d of ls("skills").filter((d) => statSync(join(ROOT, "skills", d)).isDirectory())) {
  const p = `skills/${d}/SKILL.md`;
  if (!existsSync(join(ROOT, p))) { fail(`skills/${d}: no SKILL.md`); continue; }
  const s = read(p);
  const fm = leadingFrontmatter(s);
  if (!fm) { fail(`${p}: no leading frontmatter block`); continue; }
  if (fm.name !== d) fail(`${p}: name "${fm.name}" != dir "${d}"`);
  if (!fm.description) fail(`${p}: no description in frontmatter`);
  if (!/<example>/.test(s)) fail(`${p}: no <example> block`);
  if (!/## Scope note/i.test(s)) fail(`${p}: no Scope note`);
}

// 4. command → skill cross-references resolve.
for (const f of ls("commands").filter((f) => f.endsWith(".md"))) {
  for (const m of read(`commands/${f}`).matchAll(/skills\/([a-z-]+)\/SKILL\.md/g)) {
    if (!existsSync(join(ROOT, "skills", m[1], "SKILL.md"))) fail(`commands/${f}: dangling skill ref ${m[1]}`);
  }
}

// 5. every command hook references at least one scripts/<file> and EVERY referenced script exists.
//    A command that no longer points at a script (renamed to `echo ok`, a misspelled path, or a
//    second chained script that went missing) must FAIL, not silently no-op. Structure is checked
//    explicitly — never relying on a thrown error being swallowed (that would itself be a no-op).
let hooksObj = null;
try { hooksObj = JSON.parse(read("hooks/hooks.json")).hooks; } catch { /* invalid JSON already reported in section 1 */ }
if (hooksObj && typeof hooksObj === "object" && !Array.isArray(hooksObj)) {
  for (const [event, arr] of Object.entries(hooksObj)) {
    if (!Array.isArray(arr)) { fail(`hooks.json: ${event} is not an array`); continue; }
    for (const g of arr) {
      if (!g || !Array.isArray(g.hooks)) { fail(`hooks.json: ${event} has a hook group whose "hooks" is not an array`); continue; }
      for (const h of g.hooks) {
        if (h.type !== "command") continue; // only command hooks run a script
        if (typeof h.command !== "string" || !h.command) { fail(`hooks.json: ${event} command hook has no command string`); continue; }
        const refs = [...h.command.matchAll(/scripts\/([\w.-]+)/g)].map((m) => m[1]);
        if (!refs.length) { fail(`hooks.json: ${event} command does not reference a scripts/<file> (${h.command.slice(0, 60)})`); continue; }
        for (const r of refs) if (!existsSync(join(ROOT, "scripts", r))) fail(`hooks.json: missing script scripts/${r}`);
      }
    }
  }
} else if (hooksObj !== null) {
  fail("hooks.json: top-level .hooks is not an object");
}

// 6. the gazette run artifact ships.
if (!existsSync(join(ROOT, "press", "bin", "gazette.mjs"))) fail("press/bin/gazette.mjs (the bundle) is missing");

// 7. the bureau-instructions template still carries its substitution token (init replaces it
//    when writing ./BUREAU.md).
if (existsSync(join(ROOT, "templates", "bureau-instructions.md")) && !/\{\{WORKSPACE\}\}/.test(read("templates/bureau-instructions.md")))
  fail("templates/bureau-instructions.md: lost its {{WORKSPACE}} token (init can't target the workspace)");

// 8. shipped crew members are well-formed: crew.json parses + name matches dir; agent.md has a
//    leading frontmatter block with a matching name + a description; a brief.md ships.
for (const d of ls("crew").filter((d) => d !== "_template" && statSync(join(ROOT, "crew", d)).isDirectory())) {
  const meta = `crew/${d}/crew.json`, agent = `crew/${d}/agent.md`, brief = `crew/${d}/brief.md`;
  if (!existsSync(join(ROOT, meta))) { fail(`crew/${d}: no crew.json`); continue; }
  let m; try { m = JSON.parse(read(meta)); } catch (e) { fail(`${meta}: invalid JSON: ${e.message}`); m = {}; }
  if (m.name !== d) fail(`${meta}: name "${m.name}" != dir "${d}"`);
  if (!existsSync(join(ROOT, agent))) fail(`crew/${d}: no agent.md`);
  else { const fm = leadingFrontmatter(read(agent)); if (!fm) fail(`${agent}: no leading frontmatter`); else { if (fm.name !== d) fail(`${agent}: frontmatter name "${fm.name}" != dir "${d}"`); if (!fm.description) fail(`${agent}: no description`); } }
  if (!existsSync(join(ROOT, brief))) fail(`crew/${d}: no brief.md`);
}
// 9. the author template carries its substitution tokens (crew:new substitutes them).
if (existsSync(join(ROOT, "crew", "_template"))) {
  for (const f of ["agent.md", "brief.md", "crew.json"]) {
    const p = `crew/_template/${f}`;
    if (!existsSync(join(ROOT, p))) fail(`${p}: missing from the crew author template`);
    else if (!/\{\{NAME\}\}/.test(read(p))) fail(`${p}: lost its {{NAME}} token (crew:new can't target the member)`);
  }
}

// 10. the orientation guide stays in lockstep with the command surface (the user-facing reason it
//     exists: an AI must be able to trust it). The guide skill MUST exist, and its body must name
//     every `bureau:<command>` that ships — and name no `bureau:<command>` that doesn't. New command
//     → guide goes red until documented; renamed/removed command → its stale mention goes red. This
//     is what makes "update the plugin, the guide catches up" a gate, not a discipline.
const guidePath = "skills/guide/SKILL.md";
if (!existsSync(join(ROOT, guidePath))) {
  fail(`${guidePath}: the orientation guide skill is missing`);
} else {
  const guide = read(guidePath);
  // strip the leading frontmatter so the description's own prose can't satisfy coverage — the BODY
  // is what an AI reads when the skill triggers, so coverage must hold there.
  const body = guide.replace(/^---\n[\s\S]*?\n---(\n|$)/, "");
  const commands = ls("commands").filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  const cmdSet = new Set(commands);
  for (const c of commands) {
    if (!new RegExp(`bureau:${c}\\b`).test(body)) fail(`${guidePath}: does not document command bureau:${c} (guide drifted behind the command surface)`);
  }
  for (const m of body.matchAll(/bureau:([a-z][a-z0-9-]*)\b/g)) {
    if (!cmdSet.has(m[1])) fail(`${guidePath}: references bureau:${m[1]}, which is not a command (guide drifted ahead of the command surface)`);
  }
}

if (fails.length) { console.error("✗ static check: " + fails.length + " issue(s)\n  - " + fails.join("\n  - ")); process.exit(1); }
console.log("✓ static check: all structural invariants hold");
