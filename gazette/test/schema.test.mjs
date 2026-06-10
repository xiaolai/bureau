import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildModel } from "../src/core/model.mjs";
import { lintSchema } from "../src/derive/schema.mjs";
import { doc } from "./helpers.mjs";

// build a model from an in-tmp corpus with a _types schema. `docs` maps file → meta
// object; typed relations use [[..]] values, scalar fields are plain or [a,b] lists.
function model(typeFm, docs) {
  const root = mkdtempSync(join(tmpdir(), "wb-schema-"));
  const docsDir = join(root, "docs");
  mkdirSync(join(docsDir, "_types"), { recursive: true });
  writeFileSync(join(docsDir, "_config.json"), JSON.stringify({ meta: { home: "" }, groups: [{ id: "c", label: "C" }] }));
  writeFileSync(join(docsDir, "_types", "c.html"), "---\n" + typeFm + "\n---\n<p>schema doc</p>");
  for (const [name, meta] of Object.entries(docs)) writeFileSync(join(docsDir, name), doc(meta, "body"));
  return buildModel({ docsDir });
}

test("schema: unknownEdge — typed edge not in the schema", () => {
  const m = model("applies: c\nedges: [allies]", { "a.html": { title: "A", group: "c", rival: "[[B]]" }, "b.html": { title: "B", group: "c" } });
  assert.deepEqual(lintSchema(m, m.types), [{ kind: "unknownEdge", node: "A", key: "rival" }]);
});

test("schema: allowed edges produce no finding", () => {
  const m = model("applies: c\nedges: [allies]", { "a.html": { title: "A", group: "c", allies: "[[B]]" }, "b.html": { title: "B", group: "c" } });
  assert.deepEqual(lintSchema(m, m.types), []);
});

test("schema: missingRequired and unknownField", () => {
  const m = model("applies: c\nfields: [faction]\nrequired: [faction]", { "a.html": { title: "A", group: "c", rank: "high" } });
  const kinds = lintSchema(m, m.types).map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["missingRequired", "unknownField"]);
});

test("schema: multiSingle — a single-valued field given a list", () => {
  const m = model("applies: c\nfields: [faction]\nsingle: [faction]", { "a.html": { title: "A", group: "c", faction: "[x, y]" } });
  assert.deepEqual(lintSchema(m, m.types), [{ kind: "multiSingle", node: "A", key: "faction" }]);
});

test("schema: a group with no matching schema yields no findings (graceful untyped degrade)", () => {
  // schema applies to "other", but the doc is group "c" → unchecked
  const m = model("applies: other\nedges: []", { "a.html": { title: "A", group: "c", x: "[[B]]" }, "b.html": { title: "B", group: "c" } });
  assert.deepEqual(lintSchema(m, m.types), []);
});
