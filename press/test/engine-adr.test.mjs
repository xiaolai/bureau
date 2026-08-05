// WI-5 (ADR layer) — the ADR scaffold engine module. Pure: nextAdrNumber(model) + madrScaffold(args).
// The AI never hand-computes numbering or hand-templates a page (both error-prone). madrScaffold must
// NEVER author a trust marker (the write-gate is non-negotiable) — asserted directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAdrNumber, madrScaffold } from "../src/engine/adr.mjs";
import { parseMarkdownDoc } from "../src/core/parse.mjs";

// minimal model: nextAdrNumber reads only node.kind / node.title / node.id
const mk = (...nodes) => ({ nodes: Object.fromEntries(nodes.map((n, i) => [n.title || n.id || String(i), n])) });

test("5.1 nextAdrNumber: empty model ⇒ 1", () => {
  assert.equal(nextAdrNumber({ nodes: {} }), 1);
});

test("5.2 nextAdrNumber: max+1 across kind:adr nodes, gaps tolerated", () => {
  const m = mk({ kind: "adr", id: "a", title: "ADR-0001 One" }, { kind: "adr", id: "b", title: "ADR-0002 Two" }, { kind: "adr", id: "c", title: "ADR-0005 Five" });
  assert.equal(nextAdrNumber(m), 6);
});

test("5.3 nextAdrNumber: recognises ADR-0007 by title when kind is absent", () => {
  assert.equal(nextAdrNumber(mk({ kind: null, id: "x", title: "ADR-0007 Seven" })), 8);
});

test("5.4 nextAdrNumber: a non-ADR (kind:decision) node is ignored even if titled ADR-000N", () => {
  const m = mk({ kind: "decision", id: "d", title: "ADR-0009 Decoy" }, { kind: "adr", id: "a", title: "ADR-0002 Real" });
  assert.equal(nextAdrNumber(m), 3);
});

const SECTIONS = ["Context and Problem Statement", "Decision Drivers", "Considered Options", "Decision Outcome", "Consequences", "Confirmation"];

test("5.5 madrScaffold: emits all six MADR sections in order", () => {
  const text = madrScaffold({ number: 3, title: "Use X", id: "opaque1", date: "2026-08-05" });
  const headings = text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
  assert.deepEqual(headings, SECTIONS);
});

test("5.6 madrScaffold: frontmatter is proposed / kind:adr and NEVER authors a trust marker", () => {
  const text = madrScaffold({ number: 3, title: "Use X", id: "opaque1", date: "2026-08-05" });
  assert.match(text, /^status:\s*proposed$/m);
  assert.match(text, /^kind:\s*adr$/m);
  assert.doesNotMatch(text, /canonical|approve/i); // the write-gate: a scaffold must never claim trust
});

test("5.7 madrScaffold: supersedesTitle ⇒ exactly one single-line supersedes edge", () => {
  const text = madrScaffold({ number: 4, title: "Replace Y", id: "opaque2", date: "2026-08-05", supersedesTitle: "ADR-0001 Foo" });
  assert.equal((text.match(/^supersedes:/gm) || []).length, 1);
  assert.match(text, /^supersedes:\s*"\[\[ADR-0001 Foo\]\]"$/m); // single-line inline map, [[ ]]-wrapped (a real edge)
});

test("5.8 madrScaffold: without supersedesTitle ⇒ no supersedes key", () => {
  assert.doesNotMatch(madrScaffold({ number: 4, title: "Fresh", id: "opaque3", date: "2026-08-05" }), /^supersedes:/m);
});

test("5.9 madrScaffold: output round-trips through the real parseMarkdownDoc", () => {
  const text = madrScaffold({ number: 3, title: "Use X", id: "opaque1", date: "2026-08-05", supersedesTitle: "ADR-0001" });
  const p = parseMarkdownDoc(text);
  assert.match(p.meta.title, /^ADR-0003 .* Use X$/); // numbered title (so nextAdrNumber finds it later)
  assert.equal(p.meta.kind, "adr");
  assert.ok(p.edges.some((e) => e.edgeType === "supersedes" && e.target === "ADR-0001"));
});

test("5.10 madrScaffold: deterministic for fixed inputs (date is a parameter, not Date.now)", () => {
  const args = { number: 3, title: "Use X", id: "opaque1", date: "2026-08-05" };
  assert.equal(madrScaffold(args), madrScaffold(args));
});

// ── WI-9 (ADR layer): the scaffold's Confirmation names the ledger verify convention ──
test("madrScaffold: the Confirmation section names the `gazette ledger verify` convention", () => {
  const text = madrScaffold({ number: 1, title: "X", id: "o", date: "2026-08-05" });
  assert.match(text, /## Confirmation/);
  assert.match(text, /gazette ledger verify .*--page .*--artifact/);
});

// ── audit-fix: the ADR matcher is anchored — a page that MENTIONS "ADR-NNNN" is not counted ──
test("nextAdrNumber: a page merely mentioning ADR-NNNN mid-title is NOT counted (anchored)", () => {
  assert.equal(nextAdrNumber(mk({ kind: null, id: "x", title: "See ADR-0005 for details" })), 1);
  // a real ADR that BEGINS with the pattern still counts, alongside the ignored mention
  assert.equal(nextAdrNumber(mk({ kind: null, id: "x", title: "See ADR-0005 for details" }, { kind: "adr", id: "a", title: "ADR-0003 Real" })), 4);
});
