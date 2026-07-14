// SSOT maintainer (the write lane): rename propagation + doctor repair plan/apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildModel } from "../src/core/model.mjs";
import { deriveBacklinks } from "../src/derive/backlinks.mjs";
import { deriveHealth } from "../src/derive/health.mjs";
import { planRename, applyRename } from "../src/maintain/rename.mjs";
import { buildRepairPlan, applySafe } from "../src/maintain/doctor.mjs";
import { doc } from "./helpers.mjs";

function corpus(docs, config = { meta: { home: "" }, groups: [{ id: "g", label: "G" }] }) {
  const root = mkdtempSync(join(tmpdir(), "wb-maint-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify(config));
  for (const [n, b] of Object.entries(docs)) writeFileSync(join(docsDir, n), b);
  return docsDir;
}
const read = (d, f) => readFileSync(join(d, f), "utf8");

test("rename: propagates the title + every reference (body [[..]] + typed data-* relation)", () => {
  const d = corpus({
    "a.html": doc({ title: "A", group: "g", allies: "[[B]]" }, "<p>see [[B]] and [[B|the foil]]</p>"),
    "b.html": doc({ title: "B", group: "g" }, "<p>x</p>"),
  });
  applyRename(planRename({ docsDir: d, from: "B", to: "C" }), d);
  assert.match(read(d, "b.html"), /<h1>C<\/h1>/);
  assert.match(read(d, "a.html"), /data-allies="\[\[C\]\]"/);
  assert.match(read(d, "a.html"), /see \[\[C\]\] and \[\[C\|the foil\]\]/);
  assert.doesNotMatch(read(d, "a.html"), /\[\[B\]\]/);
});

test("rename: does NOT rewrite references inside <pre>/<code> (matches model link semantics)", () => {
  const d = corpus({
    "a.html": doc({ title: "A", group: "g" }, "<p>prose [[B]]</p><pre>code [[B]]</pre><p>inline <code>[[B]]</code></p>"),
    "b.html": doc({ title: "B", group: "g" }, "<p>x</p>"),
  });
  applyRename(planRename({ docsDir: d, from: "B", to: "C" }), d);
  const a = read(d, "a.html");
  assert.match(a, /prose \[\[C\]\]/, "prose link rewritten");
  assert.match(a, /code \[\[B\]\]/, "fenced-code link preserved");
  assert.match(a, /<code>\[\[B\]\]<\/code>/, "inline-code link preserved");
});

test("rename: refuses a collision and a missing source", () => {
  const d = corpus({ "a.html": doc({ title: "A", group: "g" }, "<p>x</p>"), "b.html": doc({ title: "B", group: "g" }, "<p>x</p>") });
  assert.throws(() => planRename({ docsDir: d, from: "A", to: "B" }), /already exists/);
  assert.throws(() => planRename({ docsDir: d, from: "Ghost", to: "X" }), /no document titled/);
});

test("doctor: dangling typo gets a fuzzy auto-suggestion; orphan is advisory only", () => {
  const d = corpus({
    "a.html": doc({ title: "Alpha", group: "g" }, "<p>link to [[Alphaa]]</p>"), // typo of a nonexistent target
    "b.html": doc({ title: "Beta", group: "g" }, "<p>link [[Alpha]]</p>"),
  });
  const m = buildModel({ docsDir: d });
  const h = deriveHealth(m, deriveBacklinks(m), { now: "2026-06-09" });
  const fixes = buildRepairPlan(m, h);
  const dangling = fixes.find((f) => f.kind === "dangling");
  assert.equal(dangling.target, "Alphaa");
  assert.equal(dangling.suggest, "Alpha");
  assert.equal(dangling.auto, true); // dist 1
});

test("doctor: applySafe fixes drift + auto-dangling and leaves the corpus clean", () => {
  const d = corpus(
    {
      "a.html": doc({ title: "Alpha", group: "g" }, "<p>[[Alphaa]]</p>"),
      "b.html": doc({ title: "Beta", group: "g", updated: "2026-06-08" }, "<p>[[Alpha]] [[Alphaa]]</p>"),
    },
    { meta: { home: "", expectedDocs: 99 }, groups: [{ id: "g", label: "G" }] }
  );
  let m = buildModel({ docsDir: d });
  let h = deriveHealth(m, deriveBacklinks(m), { now: "2026-06-09" });
  const applied = applySafe(d, buildRepairPlan(m, h), m);
  assert.ok(applied.some((a) => a.includes("expectedDocs")));
  assert.ok(applied.some((a) => a.includes("Alphaa")));
  // re-derive: dangling + drift gone (orphans may remain — those are advisory)
  m = buildModel({ docsDir: d });
  h = deriveHealth(m, deriveBacklinks(m), { now: "2026-06-09" });
  assert.equal(h.counts.dangling, 0);
  assert.equal(h.counts.drift, 0);
});

test("rename: refuses a new title with wiki-breaking chars", () => {
  const d = corpus({ "a.html": doc({ title: "A", group: "g" }, "<p>x</p>") });
  assert.throws(() => planRename({ docsDir: d, from: "A", to: "B|C" }), /invalid new title/);
});

test("doctor: an ambiguous (tied) dangling typo is suggested but NOT auto-applied", () => {
  const d = corpus({
    "a.html": doc({ title: "Alpha", group: "g" }, "<p>x</p>"),
    "b.html": doc({ title: "Alphab", group: "g" }, "<p>x</p>"),
    "c.html": doc({ title: "C", group: "g" }, "<p>link [[Alphaa]]</p>"),
  });
  const m = buildModel({ docsDir: d });
  const h = deriveHealth(m, deriveBacklinks(m), { now: "2026-06-09" });
  const dangling = buildRepairPlan(m, h).find((f) => f.kind === "dangling" && f.target === "Alphaa");
  assert.ok(dangling.suggest);      // still suggested
  assert.equal(dangling.auto, false); // tie (Alpha/Alphab both dist 1) → not auto-applied
});

// ── doctor: the unsourced lane is advisory, never auto-applied ────────────────
function unsourcedPlan(sourceGroup = "logbook") {
  const model = {
    nodes: { A: { id: "A", group: "decisions", status: "proposed", file: "decisions/a.md", updated: "2026-06-12" } },
    edges: [],
    meta: { provenance: { requireFor: ["proposed"], sourceGroup, exclude: [] } },
  };
  const health = { dangling: [], orphan: [], contradiction: [], invalidDate: [], stale: [], schema: [], drift: [], unsourced: [{ node: "A", status: "proposed" }] };
  return { model, fixes: buildRepairPlan(model, health) };
}

test("doctor: an unsourced finding is surfaced as pending, never auto-fixable", () => {
  const { fixes } = unsourcedPlan();
  const f = fixes.find((x) => x.kind === "unsourced");
  assert.ok(f, "the unsourced lane must reach the repair plan");
  assert.equal(f.auto, false, "provenance is a judgment call — a machine must not invent a source");
  assert.equal(f.node, "A");
});

test("doctor: unsourced advice names the CONFIGURED source drawer, not a hardcoded one", () => {
  const { fixes } = unsourcedPlan("archive");
  const f = fixes.find((x) => x.kind === "unsourced");
  assert.match(f.advice, /archive/, "advice must follow meta.provenance.sourceGroup");
  assert.doesNotMatch(f.advice, /logbook/i);
});

test("doctor: applySafe never writes anything for an unsourced finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-unsourced-"));
  mkdirSync(join(dir, "decisions"), { recursive: true });
  const p = join(dir, "decisions", "a.md");
  const before = "---\ntitle: A\nstatus: proposed\n---\n\n# A\n\nno sources\n";
  writeFileSync(p, before);
  const { model, fixes } = unsourcedPlan();
  const applied = applySafe(dir, fixes, model);
  assert.deepEqual(applied, []);
  assert.equal(readFileSync(p, "utf8"), before, "the page must be untouched");
});
