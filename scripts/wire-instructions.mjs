#!/usr/bin/env node
// Preserve the project's instruction authority; never create a CLAUDE.md shadow.
import { existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
export function wireInstructions(cwd) {
  const root = resolve(cwd);
  const candidates = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
  let relative = candidates.find(p => existsSync(join(root, p))) || 'AGENTS.md';
  if (relative === 'AGENTS.md') {
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) {
      const shadow = candidates.find(p => existsSync(join(parent, p)));
      if (shadow) throw new Error(`Ancestor ${join(parent, shadow)} may suppress AGENTS.md. Set Project instructions to claude-md-and-agents-md, then wire @BUREAU.md into AGENTS.md manually; no files changed.`);
    }
  }
  const file = join(root, relative);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Instruction file is a symlink; wire the authoritative target explicitly, preserving its relative imports.');
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '# Project instructions\n';
  const target = relative.startsWith('.claude/') ? '../BUREAU.md' : 'BUREAU.md';
  const block = `<!-- bureau:start -->\n@${target}\n<!-- bureau:end -->`;
  const existing = /<!-- bureau:start -->[\s\S]*?<!-- bureau:end -->/;
  const next = existing.test(text) ? text.replace(existing, block) : `${text.trimEnd()}\n\n${block}\n`;
  if (next !== text) writeFileSync(file, next);
  return { file, changed: next !== text, import: `@${target}` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(wireInstructions(process.argv[2] || process.cwd()))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
