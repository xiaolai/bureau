// WI-1 — opaque identity + author-anchored spans (ADR-0001).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSpans, parseMarkdownDoc } from "../src/core/parse.mjs";
import { loadCorpus, buildModel } from "../src/core/model.mjs";

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), "wb-id-"));
  const dir = join(root, "canon");
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("extractSpans: end-of-line ^anchor marks the contiguous block; ^ mid-line is not a span", () => {
  const spans = extractSpans("A claim line. ^c1\n\nnext para\nsecond line ^c2\n\n2^8 is not an anchor");
  assert.deepEqual(spans.map((s) => s.anchor), ["c1", "c2"]);
  assert.equal(spans[0].text, "A claim line.");
  assert.equal(spans[1].text, "next para\nsecond line"); // block = contiguous non-blank lines
});

test("extractSpans: no anchors → empty", () => {
  assert.deepEqual(extractSpans("plain prose\nno anchors here"), []);
});

test("identity: authored id becomes the uid; absent id → stable title-shim", () => {
  const withId = parseMarkdownDoc("---\nid: 01ABC\ntitle: Aye\n---\n# Aye\nx");
  assert.equal(withId.meta.id, "01ABC");
  const noId = parseMarkdownDoc("---\ntitle: Bee\n---\n# Bee\nx");
  assert.equal(noId.meta.id, null);
});

test("identity: model exposes the dual index (title-key ⇄ uid)", () => {
  const w = ws({
    "a.md": "---\nid: 01AAA\ntitle: Aye\n---\n# Aye\nrests on [[Bee]]",
    "b.md": "---\ntitle: Bee\n---\n# Bee\nx",
  });
  try {
    const c = loadCorpus({ docsDir: w.dir });
    assert.equal(c.uidByKey.get("Aye"), "01AAA");   // authored id
    assert.equal(c.uidByKey.get("Bee"), "t:Bee");   // shim
    assert.equal(c.keyByUid.get("01AAA"), "Aye");
    const m = buildModel({ corpus: c });
    assert.equal(m.nodes["Aye"].uid, "01AAA");
  } finally { w.cleanup(); }
});

test("identity: rename-stability — title changes, authored uid does not", () => {
  // same authored id, different title across two builds → the uid is invariant (the property the
  // whole engine rests on; a title-derived id would break here).
  const before = buildModel({ corpus: loadCorpusOf("---\nid: 01FIX\ntitle: Old Name\n---\n# Old Name\nx") });
  const after = buildModel({ corpus: loadCorpusOf("---\nid: 01FIX\ntitle: New Name\n---\n# New Name\nx") });
  assert.equal(before.nodes["Old Name"].uid, "01FIX");
  assert.equal(after.nodes["New Name"].uid, "01FIX");
});

function loadCorpusOf(md) {
  const w = ws({ "x.md": md });
  try { return loadCorpus({ docsDir: w.dir }); } finally { w.cleanup(); }
}

test("identity: two pages with the same authored id is a loud error", () => {
  const w = ws({
    "a.md": "---\nid: DUP\ntitle: Aye\n---\n# Aye\nx",
    "b.md": "---\nid: DUP\ntitle: Bee\n---\n# Bee\nx",
  });
  try { assert.throws(() => loadCorpus({ docsDir: w.dir }), /duplicate engine id "DUP"/); }
  finally { w.cleanup(); }
});

test("identity: duplicate span anchor within one doc is a loud error", () => {
  const w = ws({ "a.md": "---\ntitle: Aye\n---\n# Aye\nfirst ^dup\n\nsecond ^dup" });
  try { assert.throws(() => loadCorpus({ docsDir: w.dir }), /duplicate span anchor "\^dup"/); }
  finally { w.cleanup(); }
});
