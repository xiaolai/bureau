import { test } from "node:test";
import assert from "node:assert/strict";
import { GOLDEN_DOCS } from "./helpers.mjs";
import { buildModel } from "../src/core/model.mjs";
import { canonicalJSON, canonicalize } from "../src/services/determinism.mjs";
import { extractLinks, splitFrontmatter } from "../src/core/parse.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("canonicalJSON is key-order independent", () => {
  const a = canonicalJSON({ b: 1, a: { d: 1, c: 2 } });
  const b = canonicalJSON({ a: { c: 2, d: 1 }, b: 1 });
  assert.equal(a, b);
});

test("canonicalize sorts nested keys, preserves array order", () => {
  // the contract is deterministic JSON (canonicalize's output is always JSON.stringify'd), so
  // assert the serialized form — the copy is a null-proto object (own "__proto__" is data, not a
  // prototype write), which strict deepEqual would otherwise reject on prototype alone.
  assert.equal(canonicalJSON({ b: 1, a: [3, 1, 2] }, 0), '{"a":[3,1,2],"b":1}');
});

test("canonicalize returns null-proto copies — an own __proto__ key is data, not pollution", () => {
  const out = canonicalize({ b: 1, a: [3, 1, 2] });
  assert.equal(Object.getPrototypeOf(out), null);
  const poison = canonicalize(JSON.parse('{"__proto__":{"x":1},"k":2}'));
  assert.equal(Object.getPrototypeOf(poison), null, "must not mutate the prototype");
  assert.equal(canonicalJSON({}), "{}", "and a plain object stays clean");
});

test("parser: typed [[link]] in frontmatter is NOT treated as inline list", () => {
  const { frontmatter } = splitFrontmatter("---\ncontradicts: [[Villain]]\ntags: [a, b]\n---\nx");
  assert.equal(frontmatter.contradicts, "[[Villain]]");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
  assert.deepEqual(extractLinks("[[Villain]]"), ["Villain"]);
});

test("buildModel: golden corpus shape", () => {
  const m = buildModel({ docsDir: GOLDEN_DOCS });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.nodeCount, 6); // Overview Hero Foil Villain Orphan Stale
  // typed contradicts edge extracted from frontmatter
  const contra = m.edges.filter((e) => e.edgeType === "contradicts");
  assert.equal(contra.length, 1);
  assert.deepEqual(contra[0], { source: "Hero", target: "Villain", edgeType: "contradicts" });
  // body link to a missing node is present as an untyped edge
  assert.ok(m.edges.some((e) => e.source === "Hero" && e.target === "OldName" && e.edgeType === null));
});

test("buildModel is deterministic (double build → byte-identical)", () => {
  const a = canonicalJSON(buildModel({ docsDir: GOLDEN_DOCS }));
  const b = canonicalJSON(buildModel({ docsDir: GOLDEN_DOCS }));
  assert.equal(a, b);
});

test("model: nav section comes from the top-level folder (data-group overrides)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = join(root, "gazette");
  mkdirSync(join(w, "10-characters"), { recursive: true });
  mkdirSync(join(w, "places"), { recursive: true });
  writeFileSync(join(w, "00-overview.html"), "<article><h1>Overview</h1>x</article>");
  writeFileSync(join(w, "10-characters", "lin.html"), "<article><h1>Lin</h1>x</article>");
  writeFileSync(join(w, "places", "city.html"), '<article data-group="character"><h1>City</h1>x</article>');
  const m = buildModel({ docsDir: w });
  assert.equal(m.nodes["Overview"].group, "");          // root file → "" section
  assert.equal(m.nodes["Lin"].group, "characters");      // folder "10-characters" → id "characters" (prefix stripped)
  assert.equal(m.nodes["City"].group, "character");       // data-group overrides the "places" folder
});
