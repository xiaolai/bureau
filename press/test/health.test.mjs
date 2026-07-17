import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolve } from "path";
import { GOLDEN_DOCS, FIXED_NOW } from "./helpers.mjs";
import { buildModel } from "../src/core/model.mjs";
import { deriveBacklinks } from "../src/derive/backlinks.mjs";
import { deriveHealth, healthTotal } from "../src/derive/health.mjs";
import { canonicalJSON } from "../src/services/determinism.mjs";

function golden() {
  const m = buildModel({ docsDir: GOLDEN_DOCS });
  return deriveHealth(m, deriveBacklinks(m), { now: FIXED_NOW });
}

test("health: detects exactly the injected drift cases (100% + no false positives)", () => {
  const h = golden();
  assert.deepEqual(h.counts, { dangling: 1, orphan: 1, contradiction: 1, invalidDate: 0, stale: 1, schema: 1, drift: 0, unsourced: 0 });
});

test("health: a _types violation is flagged (Villain.rival not in the character schema)", () => {
  assert.deepEqual(golden().schema, [{ kind: "unknownEdge", node: "Villain", key: "rival" }]);
});

test("health: dangling is the renamed link Hero -> OldName", () => {
  assert.deepEqual(golden().dangling, [{ source: "Hero", target: "OldName", edgeType: null }]);
});

test("health: orphan is Orphan", () => {
  assert.deepEqual(golden().orphan, [{ node: "Orphan" }]);
});

test("health: contradiction is the typed Hero <-> Villain pair", () => {
  assert.deepEqual(golden().contradiction, [{ a: "Hero", b: "Villain" }]);
});

test("health: stale is Stale with newer neighbor Hero", () => {
  assert.deepEqual(golden().stale, [{ node: "Stale", updated: "2026-01-01", newerNeighbor: "Hero" }]);
});

test("health: deriveHealth is deterministic — same input, identical canonical JSON", () => {
  const a = canonicalJSON(golden());
  const b = canonicalJSON(golden());
  assert.equal(a, b);
});

test("health: matches the committed golden oracle (examples/golden/expected/health.json)", () => {
  const expected = readFileSync(resolve(GOLDEN_DOCS, "..", "expected", "health.json"), "utf8");
  assert.equal(canonicalJSON(golden()) + "\n", expected);
});

// ── unsourced lane ────────────────────────────────────────────────────────────
// The trap this lane exists to close: the source drawer links OUT to the claims, so the
// graph is fully connected — zero dangling, zero orphans — while not one claim links BACK
// to the minute that justifies it. Health used to call that a clean bill.
function provModel({ provenance } = {}) {
  const n = (id, group, status) => ({ id, title: id, group, status, updated: "2026-06-12", icon: "file", file: id + ".md", attrs: {} });
  const nodes = {
    Logbook: n("Logbook", "logbook", "logbook"),        // the drawer's index page
    "minute-1": n("minute-1", "logbook", "logbook"),    // an actual minute
    Sourced: n("Sourced", "decisions", "proposed"),
    IndexOnly: n("IndexOnly", "decisions", "canonical"),
    Sibling: n("Sibling", "decisions", "verified"),
    Untiered: n("Untiered", "decisions", null),         // no trust tier → not a claim
  };
  const edges = [
    { source: "Sourced", target: "minute-1", edgeType: null },   // real provenance
    { source: "IndexOnly", target: "Logbook", edgeType: null },  // only the drawer index — NOT provenance
    { source: "Sibling", target: "Sourced", edgeType: null },    // a sibling claim — NOT provenance
    { source: "Untiered", target: "Sourced", edgeType: null },
    { source: "Logbook", target: "Sourced", edgeType: null },    // drawer links outward: the false-green trap
    { source: "minute-1", target: "Sourced", edgeType: null },
  ];
  const meta = provenance === undefined
    ? { provenance: { requireFor: ["proposed", "verified", "canonical"], sourceGroup: "logbook", exclude: ["Logbook"] } }
    : (provenance === null ? {} : { provenance });
  const model = { nodes, edges, types: {}, meta };
  return deriveHealth(model, deriveBacklinks(model), { now: FIXED_NOW });
}

test("health: unsourced flags a claim with no link back into the source drawer", () => {
  assert.deepEqual(provModel().unsourced, [
    { node: "IndexOnly", status: "canonical" },
    { node: "Sibling", status: "verified" },
  ]);
});

test("health: a claim citing a real minute is not unsourced", () => {
  assert.ok(!provModel().unsourced.some((u) => u.node === "Sourced"));
});

test("health: linking only the drawer's index page is NOT provenance (exclude)", () => {
  assert.ok(provModel().unsourced.some((u) => u.node === "IndexOnly"), "the [[Logbook]] index must not satisfy the check");
});

test("health: pages without a trust tier are not claims, so never unsourced", () => {
  assert.ok(!provModel().unsourced.some((u) => u.node === "Untiered"));
});

test("health: pages inside the source drawer are their own provenance", () => {
  const u = provModel().unsourced.map((x) => x.node);
  assert.ok(!u.includes("Logbook") && !u.includes("minute-1"));
});

test("health: the unsourced lane is inert without a _config provenance block (generic press)", () => {
  assert.deepEqual(provModel({ provenance: null }).unsourced, []);
});

test("health: unsourced counts toward the total, so it can actually fail a check", () => {
  assert.equal(healthTotal(provModel()), 2);
});

// ── unsourced: against a REAL corpus on disk, not a hand-built model ─────────
// The synthetic tests above hand-write model.meta/nodes/edges, so they would still pass if
// _config.json loading, status extraction, or body-link parsing regressed. This one drives the
// real path: files on disk → loadConfig → buildModel → deriveHealth.
function realCorpus(t, docs, config) {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "logbook"), { recursive: true });
  mkdirSync(join(dir, "decisions"), { recursive: true });
  writeFileSync(join(dir, "_config.json"), JSON.stringify(config, null, 2));
  for (const [rel, body] of Object.entries(docs)) writeFileSync(join(dir, rel), body);
  const m = buildModel({ docsDir: dir });
  return deriveHealth(m, deriveBacklinks(m), { now: FIXED_NOW });
}

const PROV_CFG = {
  meta: { provenance: { requireFor: ["proposed", "canonical"], sourceGroup: "logbook", exclude: ["Logbook"] } },
};
const DOCS = {
  "logbook/00-logbook.md": "---\ntitle: Logbook\nstatus: logbook\nupdated: 2026-06-12\n---\n\n# Logbook\n\nIndex.\n",
  "logbook/m1.md": "---\ntitle: session m1 · 2026-06-12\nstatus: logbook\nupdated: 2026-06-12\n---\n\n# m1\n\nMinute.\n",
};

test("health/real: a body **Sources.** link to a minute is provenance", (t) => {
  const h = realCorpus(t, { ...DOCS,
    "decisions/a.md": "---\ntitle: A\nstatus: proposed\nupdated: 2026-06-12\n---\n\n# A\n\n**Sources.** [[session m1 · 2026-06-12]]\n",
  }, PROV_CFG);
  assert.deepEqual(h.unsourced, []);
});

test("health/real: a claim with no provenance link is flagged", (t) => {
  const h = realCorpus(t, { ...DOCS,
    "decisions/a.md": "---\ntitle: A\nstatus: proposed\nupdated: 2026-06-12\n---\n\n# A\n\nNo sources at all.\n",
  }, PROV_CFG);
  assert.deepEqual(h.unsourced, [{ node: "A", status: "proposed" }]);
});

test("health/real: a frontmatter sources: wiki-link ALSO counts as provenance", (t) => {
  // pins the documented contract: a [[wiki-link]] is provenance wherever it sits
  const h = realCorpus(t, { ...DOCS,
    "decisions/a.md": '---\ntitle: A\nstatus: proposed\nupdated: 2026-06-12\nsources:\n  - "[[session m1 · 2026-06-12]]"\n---\n\n# A\n\nBody.\n',
  }, PROV_CFG);
  assert.deepEqual(h.unsourced, []);
});

test("health/real: a plain-string sources: list is NOT provenance", (t) => {
  // the reporter's real page: prose, not a link → no edge, no backlink, still unsourced
  const h = realCorpus(t, { ...DOCS,
    "decisions/a.md": '---\ntitle: A\nstatus: proposed\nupdated: 2026-06-12\nsources:\n  - "session m1 (RT-03 pilot; theorist: Wayne)"\n---\n\n# A\n\nBody.\n',
  }, PROV_CFG);
  assert.deepEqual(h.unsourced, [{ node: "A", status: "proposed" }]);
});

test("health/real: a [[minute]] hidden inside a code block does NOT satisfy provenance", (t) => {
  const h = realCorpus(t, { ...DOCS,
    "decisions/a.md": "---\ntitle: A\nstatus: proposed\nupdated: 2026-06-12\n---\n\n# A\n\n```\n**Sources.** [[session m1 · 2026-06-12]]\n```\n",
  }, PROV_CFG);
  assert.deepEqual(h.unsourced, [{ node: "A", status: "proposed" }], "a link the reader can't click is not provenance");
});

test("health/real: linking only the drawer index is not provenance", (t) => {
  const h = realCorpus(t, { ...DOCS,
    "decisions/a.md": "---\ntitle: A\nstatus: canonical\nupdated: 2026-06-12\n---\n\n# A\n\nSee the [[Logbook]].\n",
  }, PROV_CFG);
  assert.deepEqual(h.unsourced, [{ node: "A", status: "canonical" }]);
});

// ── malformed provenance config: fail loud, never silently disarm ────────────
for (const [why, prov] of [
  ["requireFor is a string, not an array", { requireFor: "canonical", sourceGroup: "logbook" }],
  ["requireFor is empty", { requireFor: [], sourceGroup: "logbook" }],
  ["sourceGroup is missing", { requireFor: ["proposed"] }],
  ["exclude is a string, not an array", { requireFor: ["proposed"], sourceGroup: "logbook", exclude: "Logbook" }],
  ["provenance is an array", []],
]) {
  test("health: malformed provenance config throws — " + why, (t) => {
    assert.throws(
      () => realCorpus(t, { ...DOCS, "decisions/a.md": "---\ntitle: A\nstatus: proposed\nupdated: 2026-06-12\n---\n\n# A\n\nx\n" }, { meta: { provenance: prov } }),
      /meta\.provenance is malformed/,
      "a misconfigured gate must fail loud, not report a clean bill",
    );
  });
}

// ── unsourced: it must actually SHOW UP in both reports ──────────────────────
test("health/render: the unsourced lane renders in the HTML and text reports", async () => {
  const { renderHealthHtml, renderHealthText } = await import("../src/render/health-report.mjs");
  const h = provModel();
  const html = renderHealthHtml(h);
  assert.match(html, /Unsourced/, "the board must show the lane");
  assert.match(html, /<a data-wiki="IndexOnly">IndexOnly<\/a>/, "and link the page");
  const text = renderHealthText(h);
  assert.match(text, /unsourced\s+: 2/);
  assert.match(text, /~ unsourced IndexOnly \(canonical/);
});

test("health/render: a control character in a title cannot forge a line in the text report", async () => {
  const { renderHealthText } = await import("../src/render/health-report.mjs");
  // a doc titled with an embedded newline could otherwise print its own "clean" summary line
  const h = {
    now: "2026-07-14", staleWindowDays: 30,
    counts: { dangling: 0, orphan: 1, contradiction: 0, invalidDate: 0, stale: 0, schema: 0, drift: 0, unsourced: 0 },
    dangling: [], orphan: [{ node: "evil\n  dangling links : 999" }], contradiction: [],
    invalidDate: [], schema: [], drift: [], stale: [], unsourced: [],
  };
  const text = renderHealthText(h);
  // Locate the payload by CONTENT, not by a hardcoded summary length — the summary block can grow
  // a lane without invalidating this test. The security property: the injected newline is collapsed,
  // so "dangling links : 999" survives only INLINE on the orphan's own line, never as its own line.
  assert.doesNotMatch(text, /^ {2}dangling links : 999$/m, "a title must not be able to forge a standalone summary line");
  const payloadLines = text.split("\n").filter((l) => l.includes("dangling links : 999"));
  assert.equal(payloadLines.length, 1, "the payload must appear on exactly one line");
  assert.match(payloadLines[0], /^ {2}o orphan\b/, "and that one line is the orphan entry, not a forged summary");
});

test("health/render: a hostile doc title cannot inject raw HTML into the board report", async () => {
  const { renderHealthHtml } = await import("../src/render/health-report.mjs");
  const evil = '<img src=x onerror=alert(1)>';
  const h = {
    now: "2026-07-14", staleWindowDays: 30,
    counts: { dangling: 0, orphan: 1, contradiction: 0, invalidDate: 0, stale: 0, schema: 0, drift: 0, unsourced: 0 },
    dangling: [], orphan: [{ node: evil }], contradiction: [], invalidDate: [], schema: [], drift: [], stale: [], unsourced: [],
  };
  const html = renderHealthHtml(h);
  // the security property: the title never becomes a live tag, and can't break out of the
  // attribute. (`onerror=` may survive as ESCAPED TEXT inside data-wiki — that is inert.)
  assert.doesNotMatch(html, /<img/, "a title must never reach the page as a live tag");
  // pin the exact anchor: escaped in the attribute AND in the text, and still a data-wiki
  // reference so build.mjs resolves it and the backlink index is unchanged
  assert.match(
    html,
    /<a data-wiki="&lt;img src=x onerror=alert\(1\)&gt;">&lt;img src=x onerror=alert\(1\)&gt;<\/a>/,
  );
});
