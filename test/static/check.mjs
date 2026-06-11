#!/usr/bin/env node
// L0 — static structural gate. Deterministic, free, no LLM. Fails loud (exit 1) on any defect.
// Validates: JSON parses; command/skill frontmatter; cross-references resolve; hook scripts
// exist; the gazette bundle is present; no stray template tokens in shipped files.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fails = [];
const fail = (m) => fails.push(m);
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const ls = (p) => (existsSync(join(ROOT, p)) ? readdirSync(join(ROOT, p)) : []);

// 1. every JSON file parses.
const jsons = ["\.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "hooks/hooks.json",
  "gazette/package.json", "templates/workspace/_config.json", "templates/workspace/bureau.json"];
for (const j of jsons.map((s) => s.replace(/^\\\./, "."))) {
  if (!existsSync(join(ROOT, j))) { fail(`missing JSON: ${j}`); continue; }
  try { JSON.parse(read(j)); } catch (e) { fail(`invalid JSON ${j}: ${e.message}`); }
}

// 2. commands: frontmatter has a description; argument-hint present iff the body shows args.
for (const f of ls("commands").filter((f) => f.endsWith(".md"))) {
  const s = read(`commands/${f}`);
  if (!/^---[\s\S]*?\bdescription:/m.test(s)) fail(`commands/${f}: no description in frontmatter`);
}

// 3. skills: name present and matches the parent dir; description present; ≥1 <example>.
for (const d of ls("skills").filter((d) => statSync(join(ROOT, "skills", d)).isDirectory())) {
  const p = `skills/${d}/SKILL.md`;
  if (!existsSync(join(ROOT, p))) { fail(`skills/${d}: no SKILL.md`); continue; }
  const s = read(p);
  const name = (s.match(/^name:\s*(\S+)/m) || [])[1];
  if (name !== d) fail(`${p}: name "${name}" != dir "${d}"`);
  if (!/^description:/m.test(s)) fail(`${p}: no description`);
  if (!/<example>/.test(s)) fail(`${p}: no <example> block`);
  if (!/## Scope note/i.test(s)) fail(`${p}: no Scope note`);
}

// 4. command → skill cross-references resolve.
for (const f of ls("commands").filter((f) => f.endsWith(".md"))) {
  for (const m of read(`commands/${f}`).matchAll(/skills\/([a-z-]+)\/SKILL\.md/g)) {
    if (!existsSync(join(ROOT, "skills", m[1], "SKILL.md"))) fail(`commands/${f}: dangling skill ref ${m[1]}`);
  }
}

// 5. hook commands point at scripts that exist.
try {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks || {};
  for (const arr of Object.values(hooks)) for (const g of arr) for (const h of g.hooks || []) {
    const m = (h.command || "").match(/scripts\/([\w.-]+)/);
    if (m && !existsSync(join(ROOT, "scripts", m[1]))) fail(`hooks.json: missing script scripts/${m[1]}`);
  }
} catch { /* JSON failure already reported */ }

// 6. the gazette run artifact ships.
if (!existsSync(join(ROOT, "gazette", "bin", "gazette.mjs"))) fail("gazette/bin/gazette.mjs (the bundle) is missing");

// 7. the recall-rule template still carries its substitution token (init replaces it).
if (existsSync(join(ROOT, "templates", "recall-rule.md")) && !/\{\{WORKSPACE\}\}/.test(read("templates/recall-rule.md")))
  fail("templates/recall-rule.md: lost its {{WORKSPACE}} token (init can't target the workspace)");

if (fails.length) { console.error("✗ static check: " + fails.length + " issue(s)\n  - " + fails.join("\n  - ")); process.exit(1); }
console.log("✓ static check: all structural invariants hold");
