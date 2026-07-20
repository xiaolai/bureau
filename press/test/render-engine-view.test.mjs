// The unified live ENGINE view on the Health page (freshness · artifacts · convergence) + the
// per-page artifact chip. Renders straight from hand-built projections so it isolates the render layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHealthHtml } from "../src/render/health-report.mjs";
import { metaRow } from "../src/runtime/pure.mjs";

const ZERO_HEALTH = {
  now: null, staleWindowDays: 14,
  counts: { dangling: 0, orphan: 0, contradiction: 0, invalidDate: 0, schema: 0, drift: 0, stale: 0, unsourced: 0 },
  dangling: [], orphan: [], contradiction: [], invalidDate: [], schema: [], drift: [], stale: [], unsourced: [],
};
const FRESH_CLEAN = { byKey: new Map(), drift: [], pending: 0, counts: { needsReview: 0, stale: 0, modified: 0 }, integrity: null };
const ARTS_DRIFTED = { byKey: new Map(), drift: [{ page: "Upstream", artifact: "src/auth.ts", now: "beef" }], counts: { current: 2, drifted: 1, pages: 1 }, error: null };
const CONVERGE_THRASH = {
  observations: [{ atSeq: 5, kind: "scan" }], stabilization: { verdict: "thrashing", currentDepth: 1, queueGrowth: 1, maxFirings: 3, repeatedFirings: 1 },
  current: { queueDepth: 1, tracked: 1, open: 1, broken: 0, cutoffRatio: 0.0, dirty: ["D"] }, peakQueueDepth: 2, repeatedFirings: 1, maxFirings: 3, perRunWork: { last: 1, max: 2, mean: 1.5 },
};

test("engine view: the three facets render under one Engine banner", () => {
  const h = renderHealthHtml(ZERO_HEALTH, FRESH_CLEAN, ARTS_DRIFTED, CONVERGE_THRASH);
  assert.match(h, /Engine · live state/);
  assert.match(h, /Drift · engine/);        // freshness facet (established label kept)
  assert.match(h, /Artifacts · currency/);  // artifact-currency facet
  assert.match(h, /Convergence · thrashing/); // convergence facet with its verdict
});

test("engine view: a drifted artifact surfaces the page, the file, and a DRIFTED marker", () => {
  const h = renderHealthHtml(ZERO_HEALTH, FRESH_CLEAN, ARTS_DRIFTED, null);
  assert.match(h, /src\/auth\.ts/);
  assert.match(h, /DRIFTED/);
  assert.match(h, /data-wiki="Upstream"/); // the page is a real wiki-link, not raw text
});

test("engine view: convergence prints the verdict BESIDE the raw numbers, never alone", () => {
  const h = renderHealthHtml(ZERO_HEALTH, FRESH_CLEAN, null, CONVERGE_THRASH);
  const conv = h.split("<h3>Convergence").pop();
  assert.match(conv, /queue depth 1/);
  assert.match(conv, /tracked edge/); // the cutoff/edge numbers ride alongside the verdict
});

test("engine view: an empty ledger says so instead of vanishing", () => {
  const emptyArts = { byKey: new Map(), drift: [], counts: { current: 0, drifted: 0, pages: 0 }, error: null };
  const h = renderHealthHtml(ZERO_HEALTH, FRESH_CLEAN, emptyArts, null);
  assert.match(h, /No artifacts fingerprinted yet/);
});

test("engine view: with no engine data at all, the Engine banner does not appear", () => {
  const h = renderHealthHtml(ZERO_HEALTH, null, null, null);
  assert.doesNotMatch(h, /Engine · live state/);
});

test("meta chip: a drifted artifact badge is loud; a current one is quiet", () => {
  const drifted = metaRow({ artifacts: { current: 0, drifted: 1 } });
  assert.match(drifted, /meta-chip--artifacts-drifted/);
  assert.match(drifted, /⚠ 1 drifted/);
  const current = metaRow({ artifacts: { current: 3, drifted: 0 } });
  assert.match(current, /meta-chip--artifacts-current/);
  assert.match(current, /✓ 3 current/);
});

test("meta chip: freshness and artifact badges coexist on one row", () => {
  const row = metaRow({ freshness: "needs-review", artifacts: { current: 0, drifted: 2 } });
  assert.match(row, /meta-chip--fresh-needs-review/);
  assert.match(row, /meta-chip--artifacts-drifted/);
});

test("meta chip: an empty artifacts object emits no chip", () => {
  assert.equal(metaRow({ artifacts: { current: 0, drifted: 0 } }), "");
});

// ── Trust · authority facet (the audit found the renderer inferred trust from auxiliary arrays) ──
const auth = (rows, accept = ["human"]) => ({
  accept,
  canonical: rows,
  machineBacked: rows.filter((r) => r.by && r.by !== "human"),
  unauthorized: rows.filter((r) => r.rejected),
  unbacked: rows.filter((r) => r.by == null),
});
const withAuth = (rows, accept) => ({ ...FRESH_CLEAN, authority: auth(rows, accept) });

test("trust facet: an all-human canon gets the clean human certification", () => {
  const h = renderHealthHtml(ZERO_HEALTH, withAuth([{ page: "A", by: "human", authorized: true, rejected: false }]), null, null);
  assert.match(h, /Trust · authority/);
  assert.match(h, /approved by a <strong>human<\/strong>/);
});

test("trust facet: an UNBACKED canonical never gets a green human certification", () => {
  // the bug: `by: null` sat in neither machineBacked nor unauthorized, so the clean branch fired and
  // certified a page nobody approved as human-approved.
  const rows = [{ page: "A", by: "human", authorized: true, rejected: false },
                { page: "B", by: null, authorized: false, rejected: false }];
  const h = renderHealthHtml(ZERO_HEALTH, withAuth(rows), null, null);
  assert.doesNotMatch(h, /approved by a <strong>human<\/strong>/); // NOT certified
  assert.match(h, /unbacked/);
  assert.match(h, /data-wiki="B"/);
});

test("trust facet: a rejected HUMAN approval is reported even with zero machine-backed pages", () => {
  // under approve:["invariant"] a human approval is unauthorized — the banner used to be guarded on
  // machineBacked.length, so this vanished entirely and the summary said "0 … NON-human".
  const rows = [{ page: "A", by: "human", authorized: false, rejected: true }];
  const h = renderHealthHtml(ZERO_HEALTH, withAuth(rows, ["invariant"]), null, null);
  assert.match(h, /does NOT accept/);
  assert.doesNotMatch(h, /0 approved by a NON-human/);
  assert.match(h, /not backed by an accepted authority/); // reaches the Engine banner
});

test("trust facet: a mixed corpus hides no rows", () => {
  // `rows = unauthorized.length ? unauthorized : machineBacked` dropped the accepted machine page.
  const rows = [{ page: "Acc", by: "invariant", authorized: true, rejected: false },
                { page: "Rej", by: "human", authorized: false, rejected: true }];
  const h = renderHealthHtml(ZERO_HEALTH, withAuth(rows, ["invariant"]), null, null);
  assert.match(h, /data-wiki="Acc"/);
  assert.match(h, /data-wiki="Rej"/);
});
