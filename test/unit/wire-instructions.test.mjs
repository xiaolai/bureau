import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireInstructions } from '../../scripts/wire-instructions.mjs';
for (const layout of ['AGENTS.md','CLAUDE.md','.claude/CLAUDE.md']) test(`preserves ${layout} authority and is idempotent`, () => {
 const d=mkdtempSync(join(tmpdir(),'bureau-wire-'));
 try { if(layout.includes('/')) mkdirSync(join(d,'.claude')); writeFileSync(join(d,layout),'Keep this rule.\n');
 const a=wireInstructions(d); assert.match(readFileSync(a.file,'utf8'),/Keep this rule/); assert.equal(wireInstructions(d).changed,false);
 assert.equal(existsSync(join(d,'CLAUDE.md')),layout==='CLAUDE.md');
 assert.match(readFileSync(a.file,'utf8'),layout.startsWith('.claude')?/@\.\.\/BUREAU.md/:/@BUREAU.md/);
 } finally { rmSync(d,{recursive:true,force:true}); }
});
test('ancestor shadow is reported before mutation',()=>{
 const d=mkdtempSync(join(tmpdir(),'bureau-wire-')); try{writeFileSync(join(d,'CLAUDE.md'),'ancestor');mkdirSync(join(d,'child'));assert.throws(()=>wireInstructions(join(d,'child')),/Ancestor/);assert.equal(existsSync(join(d,'child/AGENTS.md')),false);}finally{rmSync(d,{recursive:true,force:true});}
});
