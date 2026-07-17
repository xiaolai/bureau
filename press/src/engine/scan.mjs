// engine/scan — the mechanical event producer (ADR-0001). Diffs each authored span's current
// content hash against the decision log and appends introduce/edit/delete events. In v0.7 this is
// the ONLY thing that feeds the log's structural events; in v0.8 hooks call the same append API
// live on save — identical events, different trigger. Deterministic: iterates entries in file
// order (discover() sorts), spans in document order.
import { loadCorpus } from "../core/model.mjs";
import { logPath, readLog, appendEvent } from "./log.mjs";
import { projectRevisions, spanHash, spanKey } from "./revisions.mjs";

// Produce events to reconcile the log with the current corpus. Returns the list of appended events
// (already written) + a summary. `apply:false` computes the diff WITHOUT writing (for dry-run).
export function scan({ docsDir, corpus, apply = true } = {}) {
  const c = corpus || loadCorpus({ docsDir });
  const lf = logPath(docsDir || c.docsDir);
  const events = readLog(lf);
  const state = projectRevisions(events);

  const planned = [];
  const seen = new Set();
  for (const e of c.entries) {
    for (const s of e.spans || []) {
      const k = spanKey(e.uid, "^" + s.anchor);
      seen.add(k);
      const h = spanHash(s.text);
      const prev = state.get(k);
      if (!prev) planned.push({ type: "introduce", id: e.uid, span: "^" + s.anchor, hash: h });
      else if (prev.hash !== h || !prev.alive) planned.push({ type: "edit", id: e.uid, span: "^" + s.anchor, hash: h, prev: prev.hash });
      // unchanged, alive → no event
    }
  }
  // spans the log still believes alive but that are gone from the corpus → delete (deterministic
  // order). Read uid/span straight off the state value — never re-split the composite Map key.
  for (const [k, s] of [...state.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!s.alive || seen.has(k)) continue;
    planned.push({ type: "delete", id: s.uid, span: s.span });
  }

  const appended = [];
  if (apply) for (const ev of planned) appended.push(appendEvent(lf, ev));
  const summary = { introduced: 0, edited: 0, deleted: 0 };
  for (const ev of planned) summary[ev.type === "introduce" ? "introduced" : ev.type === "edit" ? "edited" : "deleted"]++;
  return { planned, appended, summary };
}
