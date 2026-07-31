// engine/review-digest — the semantic page digest that content-binds an approval (ADR-0004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewDigest, semanticFrontmatter } from "../src/engine/review-digest.mjs";

const page = (fm, body) => `---\n${fm}\n---\n${body}`;

test("review-digest: identical content -> identical, well-formed digest", () => {
  const a = reviewDigest({ raw: page("claim: X\ntype: fact", "The body.\n"), uid: "u1", title: "T" });
  const b = reviewDigest({ raw: page("claim: X\ntype: fact", "The body.\n"), uid: "u1", title: "T" });
  assert.equal(a, b);
  assert.match(a, /^bureau-page-v1:[0-9a-f]{64}$/);
});

test("review-digest: a NON-semantic/derived key change does NOT change the digest", () => {
  const base = reviewDigest({ raw: page("claim: X\nstatus: proposed", "Body.\n"), uid: "u1", title: "T" });
  for (const k of ["status", "reviewed", "updated", "verified", "trust", "effective_status", "age", "words", "icon", "group"]) {
    const d = reviewDigest({ raw: page(`claim: X\n${k}: whatever`, "Body.\n"), uid: "u1", title: "T" });
    assert.equal(d, base, `${k} must not affect the digest`);
  }
});

test("review-digest: a SEMANTIC change (claim, body, uid, title) DOES change the digest", () => {
  const base = reviewDigest({ raw: page("claim: X", "Body.\n"), uid: "u1", title: "T" });
  assert.notEqual(reviewDigest({ raw: page("claim: Y", "Body.\n"), uid: "u1", title: "T" }), base, "claim");
  assert.notEqual(reviewDigest({ raw: page("claim: X", "Other body.\n"), uid: "u1", title: "T" }), base, "body");
  assert.notEqual(reviewDigest({ raw: page("claim: X", "Body.\n"), uid: "u2", title: "T" }), base, "uid");
  assert.notEqual(reviewDigest({ raw: page("claim: X", "Body.\n"), uid: "u1", title: "T2" }), base, "title");
  assert.notEqual(reviewDigest({ raw: page("claim: X\nextra: v", "Body.\n"), uid: "u1", title: "T" }), base, "new authored key");
});

test("review-digest: cosmetic normalization (CRLF, terminal newlines, Unicode NFC everywhere) is stable", () => {
  const base = reviewDigest({ raw: page("claim: X", "line one\nline two\n"), uid: "u1", title: "T" });
  assert.equal(reviewDigest({ raw: page("claim: X", "line one\r\nline two\r\n"), uid: "u1", title: "T" }), base, "CRLF");
  assert.equal(reviewDigest({ raw: page("claim: X", "line one\nline two\n\n\n"), uid: "u1", title: "T" }), base, "terminal newlines");
  // build the two Unicode forms at runtime so the source stays pure-ASCII (composed e-acute vs NFD e + combining acute)
  const composed = "caf" + String.fromCharCode(0x00e9);
  const decomposed = "cafe" + String.fromCharCode(0x0301);
  assert.notEqual(composed, decomposed, "the two forms differ before normalization");
  assert.equal(
    reviewDigest({ raw: page("claim: " + composed, composed + "\n"), uid: "u1", title: composed }),
    reviewDigest({ raw: page("claim: " + decomposed, decomposed + "\n"), uid: "u1", title: decomposed }),
    "NFC on body, frontmatter, and title");
});

test("review-digest: Markdown-significant whitespace (blank line, indent, trailing hard-break) IS bound", () => {
  const oneBlank = reviewDigest({ raw: page("claim: X", "para one\npara two\n"), uid: "u1", title: "T" });
  assert.notEqual(reviewDigest({ raw: page("claim: X", "para one\n\npara two\n"), uid: "u1", title: "T" }), oneBlank, "added blank line");
  assert.notEqual(
    reviewDigest({ raw: page("claim: X", "    code\n"), uid: "u1", title: "T" }),
    reviewDigest({ raw: page("claim: X", "code\n"), uid: "u1", title: "T" }), "leading indent");
  assert.notEqual(
    reviewDigest({ raw: page("claim: X", "a  \nb\n"), uid: "u1", title: "T" }),
    reviewDigest({ raw: page("claim: X", "a\nb\n"), uid: "u1", title: "T" }), "trailing hard-break (two spaces)");
});

test("review-digest: propagates the parser's fail-loud error on invalid frontmatter (never silently hashes)", () => {
  assert.throws(() => reviewDigest({ raw: page("claim: X\nclaim: Y", "b\n"), uid: "u1", title: "T" }), /duplicate frontmatter key/, "duplicate key");
  assert.throws(() => reviewDigest({ raw: "---\ndesc: |\n  block scalar\n---\nb\n", uid: "u1", title: "T" }), "block scalar in frontmatter");
  assert.throws(() => reviewDigest({ raw: "---\nnested:\n  a: 1\n---\nb\n", uid: "u1", title: "T" }), "nested map in frontmatter");
});

test("semanticFrontmatter drops non-semantic + id/title, keeps authored keys", () => {
  const sf = semanticFrontmatter({ id: "x", title: "T", status: "proposed", reviewed: "2026-01-01", claim: "C", type: "fact", custom: "v" });
  assert.deepEqual(Object.keys(sf).sort(), ["claim", "custom", "type"]);
});
