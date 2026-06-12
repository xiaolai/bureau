// maintain/rename — propagate a title rename across the SSOT (the WRITE lane, kept
// separate from the read-only build). Rewrites the doc's own title (frontmatter
// title:, data-title, <h1>) and every reference — bare [[Old]] / [[Old|label]],
// <a data-wiki="Old">, and typed data-<rel>="…Old…" — to the new title, protecting
// <pre>/<code>. Deterministic; planRename computes the edits, applyRename writes them.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadCorpus } from "../core/model.mjs";
import { rewriteWikiRef, rewriteTitle } from "../core/parse.mjs";
import { nfc } from "../services/i18n.mjs";

export function planRename({ docsDir, from, to }) {
  if (!from || !to) throw new Error("rename needs both <old> and <new> titles");
  // the new title must satisfy the same invariant as any doc title — else the rewrite
  // could inject attributes (a quote) or break [[..]] semantics (a `|`/bracket).
  if (/[[\]|]/.test(String(to))) throw new Error('invalid new title (must not contain [ ] |): "' + to + '"');
  const corpus = loadCorpus({ docsDir }); // validates the corpus first (fail loud)
  const fromId = nfc(from), toId = nfc(to);
  if (fromId === toId) throw new Error("old and new titles are the same");
  const fromEntry = corpus.entries.find((e) => e.id === fromId);
  if (!fromEntry) throw new Error('no document titled [' + from + ']');
  if (corpus.entries.some((e) => e.id === toId)) throw new Error('the title [' + to + '] already exists - the rename would collide');

  const edits = [];
  let linkTotal = 0;
  for (const e of corpus.entries) {
    const raw = readFileSync(join(docsDir, e.file), "utf8");
    const ref = rewriteWikiRef(raw, from, to);
    let next = ref.html, titleChanged = false;
    if (e.id === fromId) { const t = rewriteTitle(next, from, to); next = t.html; titleChanged = t.changed; }
    linkTotal += ref.count;
    if (next !== raw) edits.push({ file: e.file, raw, next, links: ref.count, titleChanged });
  }
  return { from, to, edits, linkTotal };
}

export function applyRename(plan, docsDir) {
  for (const e of plan.edits) writeFileSync(join(docsDir, e.file), e.next);
  return { files: plan.edits.length, links: plan.linkTotal };
}
