// Configurable sidebar section order via _config.json groups[] order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderGroups } from "../src/core/model.mjs";
import { buildSite } from "../src/build.mjs";

test("orderGroups: listed ids come first in config order; unlisted keep stable order after", () => {
  const gs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(orderGroups(gs, ["c", "a"]).map((g) => g.id), ["c", "a", "b", "d"]);
  assert.deepEqual(orderGroups(gs, []).map((g) => g.id), ["a", "b", "c", "d"]); // empty ⇒ unchanged
  assert.deepEqual(orderGroups(gs, ["z"]).map((g) => g.id), ["a", "b", "c", "d"]); // unknown id ⇒ no-op
});

test("build: _config groups[] order drives the sidebar, positioning even a generated section (Health)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-side-"));
  try {
    const dir = join(root, "canon");
    mkdirSync(join(dir, "zeta"), { recursive: true });
    mkdirSync(join(dir, "alpha"), { recursive: true });
    writeFileSync(join(dir, "00-overview.md"), "---\ntitle: Overview\n---\n# Overview\nx");
    writeFileSync(join(dir, "zeta", "z.md"), "---\ntitle: Zed\n---\n# Zed\nx");
    writeFileSync(join(dir, "alpha", "a.md"), "---\ntitle: Ay\n---\n# Ay\nx");
    // authored order: zeta, then the generated Health, then alpha — the opposite of folder order
    writeFileSync(join(dir, "_config.json"), JSON.stringify({
      meta: { title: "T", home: "Overview" },
      groups: [{ id: "zeta" }, { id: "health" }, { id: "alpha" }],
    }));
    const out = join(root, "dist");
    buildSite({ root, docsDir: dir, outDir: out, force: true });
    const story = JSON.parse(readFileSync(join(out, "lib", "content.js"), "utf8").replace(/^[\s\S]*?window\.STORY = /, "").replace(/;\s*$/, ""));
    const order = story.groups.map((g) => g.id);
    assert.ok(order.indexOf("zeta") < order.indexOf("alpha"), "zeta before alpha (reversed from folder order)");
    assert.ok(order.indexOf("health") > order.indexOf("zeta") && order.indexOf("health") < order.indexOf("alpha"), "generated Health positioned between them");
    assert.ok(order.indexOf("") > order.indexOf("alpha"), 'unlisted root section ("") appended after listed ones');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
