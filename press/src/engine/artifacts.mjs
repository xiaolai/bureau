// engine/artifacts - artifact CURRENCY as the board should show it. The `_verify.json` ledger records
// which real file each claim was checked against, at what hash; this re-hashes them against the
// working tree so a `canonical` claim whose verified file changed underneath it shows DRIFTED in the
// gazette. It closes the claim<->file loop the CLI (`ledger recheck`) already knew but the board never
// showed — the one place the canon touches the real repository and can silently rot.
//
// Pure over (ledger + working tree); it NEVER writes. Tolerant by design: a broken/missing ledger, a
// deleted artifact, or a symlink escape degrades to `drifted` (or an `error` note), never a failed
// build — the gazette must always render.
import { readVerify, recheckChecks } from "./ledgers.mjs";
import { nfc } from "../services/i18n.mjs";

// Returns:
//   byKey  Map<pageKey, { current, drifted }>  — for the per-page chip (only pages that resolve)
//   drift  [{ page, artifact, now }]            — the drifted rows for the Engine view (now:null = gone)
//   counts { current, drifted, pages }          — totals across every fingerprinted page
//   error  string|null                          — a malformed ledger, surfaced not thrown
//
// The ledger is read (and validated) ONCE and every check re-hashed from that single snapshot, so a
// concurrent atomic ledger write can never tear this view across two states, and a page's checks are
// not re-parsed per call. NOTE: `_verify.json` is keyed by page TITLE; `gazette rename` does not migrate
// it, so a renamed surviving page's fingerprints resolve to no key (no chip; drift rows carry the old
// title). That is a known limitation of the title-keyed ledger, tracked separately — not introduced here.
export function liveArtifacts({ workspaceDir, root, corpus, model }) {
  let db;
  try { db = readVerify(workspaceDir); }
  catch (e) { return { byKey: new Map(), drift: [], counts: { current: 0, drifted: 0, pages: 0 }, error: e.message }; }

  const byKey = new Map();
  const drift = [];
  const counts = { current: 0, drifted: 0, pages: 0 };
  for (const title of Object.keys(db).sort()) {
    const entry = db[title];
    const rows = entry && Array.isArray(entry.checks) ? recheckChecks(root, entry.checks) : [];
    if (!rows.length) continue;
    counts.pages++;
    let cur = 0, dr = 0;
    for (const r of rows) {
      if (r.ok) { cur++; counts.current++; }
      else { dr++; counts.drifted++; drift.push({ page: title, artifact: r.artifact, now: r.now }); }
    }
    // map the ledger's page TITLE onto the board's page key (title → uid → key), AGGREGATING so two
    // NFC-equivalent ledger keys that resolve to the same page sum rather than clobber. A title that
    // resolves to no page (renamed/deleted) still shows in `drift`; it just carries no chip.
    const node = model && model.nodes ? model.nodes[nfc(String(title))] : null;
    const key = node && corpus && corpus.keyByUid ? corpus.keyByUid.get(node.uid) : null;
    if (key) { const prev = byKey.get(key) || { current: 0, drifted: 0 }; byKey.set(key, { current: prev.current + cur, drifted: prev.drifted + dr }); }
  }
  // total order for a deterministic render (mirrors live.mjs)
  drift.sort((a, b) => { const A = JSON.stringify([a.page, a.artifact]), B = JSON.stringify([b.page, b.artifact]); return A < B ? -1 : A > B ? 1 : 0; });
  return { byKey, drift, counts, error: null };
}

// A stable fingerprint of every ledger-referenced artifact's CURRENT content (or a MISSING marker),
// for the build-input hash. Ledger artifacts live OUTSIDE docs/assets/code, so without this a change to
// a verified file would not alter the input hash — and the incremental cache would keep serving a board
// that still says CURRENT instead of DRIFTED. Read once; tolerant of a broken ledger (returns "").
export function artifactInputDigest({ workspaceDir, root }) {
  let db;
  try { db = readVerify(workspaceDir); }
  catch { return ""; } // a malformed ledger is surfaced by liveArtifacts.error, not by busting the cache
  const parts = [];
  for (const page of Object.keys(db).sort()) {
    const entry = db[page];
    const checks = entry && Array.isArray(entry.checks) ? entry.checks : [];
    for (const r of recheckChecks(root, checks)) parts.push(page + "\0" + r.artifact + "\0" + (r.now || "MISSING"));
  }
  return parts.sort().join("\n");
}
