// The render/engine CLI default content dir: auto-detect a bureau workspace (a */bureau.json child)
// when --dir is omitted, else fall back to "gazette".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const run = (cwd, args) => execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("cli: no --dir → a single */bureau.json child is auto-detected as the content dir", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cdir-"));
  try {
    const ws = join(root, "canon"); mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "bureau.json"), '{"workspace":"canon","board":"gazette"}');
    // two mutually-linked pages ⇒ no orphans/dangling ⇒ health exits 0 (execFileSync wouldn't throw)
    writeFileSync(join(ws, "00-overview.md"), "---\ntitle: Overview\n---\n# Overview\nsee [[Second]]");
    writeFileSync(join(ws, "second.md"), "---\ntitle: Second\n---\n# Second\nback to [[Overview]]");
    // no --dir, no gazette/ dir: it must find canon/ (via its bureau.json), not the "gazette" default
    const out = run(root, ["health"]);
    assert.match(out, /dangling links\s*:\s*0/); // rendered the workspace successfully
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cli: no --dir and no bureau workspace → falls back to gazette (absent ⇒ fails loudly)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cdir2-"));
  try {
    // no */bureau.json and no gazette/ → default "gazette" is used and reported missing (non-zero exit)
    assert.throws(() => run(root, ["health"]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cli: an explicit --dir always wins over auto-detect", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cdir3-"));
  try {
    const ws = join(root, "canon"); mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "bureau.json"), '{"workspace":"canon"}');
    const other = join(root, "other"); mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "00-overview.md"), "---\ntitle: Overview\n---\n# Overview\nsee [[Second]]");
    writeFileSync(join(other, "second.md"), "---\ntitle: Second\n---\n# Second\nback to [[Overview]]");
    const out = run(root, ["health", "--dir", "other"]); // explicit --dir=other, not the auto-detected canon
    assert.match(out, /dangling links\s*:\s*0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
