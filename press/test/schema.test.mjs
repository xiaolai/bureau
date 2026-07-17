import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildModel } from "../src/core/model.mjs";
import { lintSchema } from "../src/derive/schema.mjs";
import { doc } from "./helpers.mjs";

// build a model from an in-tmp corpus with a _types schema. `docs` maps file → meta
// object; typed relations use [[..]] values, scalar fields are plain or [a,b] lists.
// `t` (the test context) registers cleanup so the corpus doesn't leak across runs.
function model(t, typeFm, docs) {
  const root = mkdtempSync(join(tmpdir(), "wb-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const docsDir = join(root, "docs");
  mkdirSync(join(docsDir, "_types"), { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "" }, groups: [{ id: "c", label: "C" }] }));
  writeFileSync(join(docsDir, "_types", "c.html"), "---\n" + typeFm + "\n---\n<p>schema doc</p>");
  for (const [name, meta] of Object.entries(docs)) writeFileSync(join(docsDir, name), doc(meta, "body"));
  return buildModel({ docsDir });
}

test("schema: unknownEdge — typed edge not in the schema", (t) => {
  const m = model(t, "applies: c\nedges: [allies]", { "a.html": { title: "A", group: "c", rival: "[[B]]" }, "b.html": { title: "B", group: "c" } });
  assert.deepEqual(lintSchema(m, m.types), [{ kind: "unknownEdge", node: "A", key: "rival" }]);
});

test("schema: allowed edges produce no finding", (t) => {
  const m = model(t, "applies: c\nedges: [allies]", { "a.html": { title: "A", group: "c", allies: "[[B]]" }, "b.html": { title: "B", group: "c" } });
  assert.deepEqual(lintSchema(m, m.types), []);
});

test("schema: missingRequired and unknownField (full findings — node + key, not just kind)", (t) => {
  const m = model(t, "applies: c\nfields: [faction]\nrequired: [faction]", { "a.html": { title: "A", group: "c", rank: "high" } });
  // asserting only kinds would pass even if the wrong node/key were reported; pin the whole object.
  // lintSchema sorts by JSON.stringify, so "missingRequired" precedes "unknownField".
  assert.deepEqual(lintSchema(m, m.types), [
    { kind: "missingRequired", node: "A", key: "faction" },
    { kind: "unknownField", node: "A", key: "rank" },
  ]);
});

test("schema: multiSingle — a single-valued field given a list", (t) => {
  const m = model(t, "applies: c\nfields: [faction]\nsingle: [faction]", { "a.html": { title: "A", group: "c", faction: "[x, y]" } });
  assert.deepEqual(lintSchema(m, m.types), [{ kind: "multiSingle", node: "A", key: "faction" }]);
});

test("schema: a group with no matching schema yields no findings (graceful untyped degrade)", (t) => {
  // schema applies to "other", but the doc is group "c" → unchecked
  const m = model(t, "applies: other\nedges: []", { "a.html": { title: "A", group: "c", x: "[[B]]" }, "b.html": { title: "B", group: "c" } });
  assert.deepEqual(lintSchema(m, m.types), []);
});

test("schema: required 'type' is satisfiable — a doc with a type meets it (was always failing)", (t) => {
  // RESERVED_PRESENT checks node.type; before the fix nodes never carried `type`, so a schema
  // requiring it could NEVER be satisfied. A doc with data-type present must produce no finding.
  const withType = model(t, "applies: c\nrequired: [type]", { "a.html": { title: "A", group: "c", type: "hero" } });
  assert.deepEqual(lintSchema(withType, withType.types), []);
});

test("schema: required 'type' is flagged when the doc has no type", (t) => {
  const noType = model(t, "applies: c\nrequired: [type]", { "a.html": { title: "A", group: "c" } });
  assert.deepEqual(lintSchema(noType, noType.types), [{ kind: "missingRequired", node: "A", key: "type" }]);
});

test("schema: two _types files claiming the same group throw (was silent last-wins)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-dup-types-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const docsDir = join(root, "docs");
  mkdirSync(join(docsDir, "_types"), { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "" } }));
  writeFileSync(join(docsDir, "_types", "a.html"), "---\napplies: c\nedges: [x]\n---\n<p>one</p>");
  writeFileSync(join(docsDir, "_types", "b.html"), "---\napplies: c\nedges: [y]\n---\n<p>two</p>");
  assert.throws(() => buildModel({ docsDir }), /duplicate _types schema for group "c"/);
});
