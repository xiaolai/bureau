// maintain/rename — propagate a title rename across the SSOT (the WRITE lane, kept
// separate from the read-only build). Rewrites the doc's own title (frontmatter
// title:, data-title, <h1>) and every reference — bare [[Old]] / [[Old|label]],
// <a data-wiki="Old">, and typed data-<rel>="…Old…" — to the new title, protecting
// <pre>/<code>. Deterministic; planRename computes the edits, applyRename writes them.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { loadCorpus, safeDocPath } from "../core/model.mjs";
import { rewriteWikiRef, rewriteTitle } from "../core/parse.mjs";
import { nfc } from "../services/i18n.mjs";

// a title becomes both an attribute value and a [[wiki-link]] target — reject anything that could
// break out of either: brackets/pipe ([[..]] semantics), `#` (the heading delimiter, so the target
// can't be addressed), and control chars (a CR/LF could inject an extra frontmatter line on rewrite).
const BAD_TITLE = /[[\]|#]|[\x00-\x1f\x7f-\x9f]/; // C0 + DEL + C1 controls

export function planRename({ docsDir, from, to }) {
  if (!from || !to) throw new Error("rename needs both <old> and <new> titles");
  if (BAD_TITLE.test(String(to))) throw new Error('invalid new title (must not contain [ ] | # or control characters): "' + to + '"');
  const corpus = loadCorpus({ docsDir }); // validates the corpus first (fail loud)
  const fromId = nfc(from), toId = nfc(to);
  if (fromId === toId) throw new Error("old and new titles are the same");
  const fromEntry = corpus.entries.find((e) => e.id === fromId);
  if (!fromEntry) throw new Error('no document titled [' + from + ']');
  if (corpus.entries.some((e) => e.id === toId)) throw new Error('the title [' + to + '] already exists - the rename would collide');

  // rewrite against the CANONICAL stored title, not the raw `from` the user typed: an NFC-equivalent
  // input finds the doc (by fromId) but would fail to match its links/title if rewritten verbatim.
  const fromTitle = fromEntry.title;
  const edits = [];
  let linkTotal = 0;
  for (const e of corpus.entries) {
    const raw = readFileSync(safeDocPath(docsDir, e.file), "utf8"); // verified path, never through a symlink
    const ref = rewriteWikiRef(raw, fromTitle, to);
    let next = ref.html, titleChanged = false;
    if (e.id === fromId) { const t = rewriteTitle(next, fromTitle, to); next = t.html; titleChanged = t.changed; }
    linkTotal += ref.count;
    if (next !== raw) edits.push({ file: e.file, raw, next, links: ref.count, titleChanged });
  }
  return { from, to, edits, linkTotal };
}

export function applyRename(plan, docsDir) {
  // Two-phase, so a partial failure can't leave the corpus half-renamed: resolve+verify every
  // path and stage each new body to a temp file FIRST (any error aborts before a single original
  // is touched), then atomically rename the temps into place. safeDocPath rejects a forged
  // edit.file that path-traverses or points through a symlink.
  const staged = [];
  try {
    for (const e of plan.edits) {
      const dest = safeDocPath(docsDir, e.file);
      const tmp = dest + ".rename-" + process.pid + ".tmp";
      staged.push({ tmp, dest, raw: e.raw }); // track BEFORE writing, so a failed write's temp is still cleaned
      writeFileSync(tmp, e.next);
    }
  } catch (err) {
    for (const s of staged) { try { unlinkSync(s.tmp); } catch { /* best-effort cleanup */ } }
    throw err;
  }
  // commit phase: each rename is atomic. If one fails after earlier files were replaced, restore the
  // already-committed ones from their captured originals (best-effort) so the corpus isn't left half
  // renamed — then surface the error. Remaining temps are cleaned up regardless.
  const done = [];
  try {
    for (const s of staged) { renameSync(s.tmp, s.dest); done.push(s); }
  } catch (err) {
    for (const s of done) { try { writeFileSync(s.dest, s.raw); } catch { /* best-effort rollback */ } }
    for (const s of staged) { try { unlinkSync(s.tmp); } catch { /* temp may already be renamed away */ } }
    throw err;
  }
  return { files: plan.edits.length, links: plan.linkTotal };
}
