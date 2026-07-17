// bureau:impact / gazette impact — pre-change blast radius (reverse rests_on closure via the CLI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const run = (dir, args) => execFileSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-impact-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("impact: lists the pages that (transitively) rest on a claim", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Upstream\n---\n# Upstream\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\" }\n---\n# Downstream\nclaim ^d\n",
  });
  try {
    const out = run(w.dir, ["impact", "Upstream"]);
    assert.match(out, /1 page\(s\) rest on it/);
    assert.match(out, /Downstream/);
  } finally { w.cleanup(); }
});

test("impact: a leaf reports safe-to-change", () => {
  const w = ws({
    "u.md": "---\nid: U\ntitle: Upstream\n---\n# Upstream\ndef ^u\n",
    "d.md": "---\nid: D\ntitle: Downstream\nrests_on:\n  - { page: \"[[Upstream]]\", span: \"^u\" }\n---\n# Downstream\nclaim ^d\n",
  });
  try {
    assert.match(run(w.dir, ["impact", "Downstream"]), /nothing rests on it/);
  } finally { w.cleanup(); }
});

test("impact: an unknown page fails loudly", () => {
  const w = ws({ "u.md": "---\nid: U\ntitle: Upstream\n---\n# Upstream\nx ^u\n" });
  try {
    assert.throws(() => run(w.dir, ["impact", "Nope"]));
  } finally { w.cleanup(); }
});
