// engine/review-digest — the versioned SEMANTIC page digest that content-binds an approval (ADR-0004).
// An `approve` event carries this digest of the page it vouched for; the projection treats the approval
// as effective only while the page still hashes to it, so a MEANINGFUL edit after approval invalidates
// the approval — but a cosmetic / engine-derived stamp (status, reviewed, updated, …) does not.
//
// v1 payload: { version:1, uid, title, semanticFrontmatter, normalizedBody }, canonicalJSON-serialized
// then sha256'd. Pure — no I/O, no clock. Excludes a fixed, reviewed set of non-semantic / derived
// keys; binds everything else the author wrote (claim, type, provenance, rests_on, unknown keys).
import { createHash } from "crypto";
import { canonicalJSON } from "../services/determinism.mjs";
import { splitFrontmatter } from "../core/parse.mjs";

export const REVIEW_DIGEST_VERSION = 1;
// Non-semantic / engine-derived / cosmetic keys — a change to any of these must NOT invalidate an
// approval. Everything NOT here is semantic and IS bound. PRIVATE (not exported): a Set's contents
// stay mutable through `.add()` even after `Object.freeze`, so exporting it would let any module widen
// the exclusion process-wide (`NON_SEMANTIC_KEYS.add("claim")` → claim edits stop invalidating). Keep
// it unreachable from outside instead. This set is the v1 contract.
const NON_SEMANTIC_KEYS = new Set([
  "status", "trust", "effective_status", "superseded_by", "reviewed", "verified", "updated", "age", "words", "icon", "group",
]);

// Deep-NFC every string in a value (scalars, arrays, plain-object values) so a page re-saved under a
// different Unicode normalization keeps its digest. Keys are frontmatter identifiers (ASCII), so only
// values are normalized.
const nfc = (v) => typeof v === "string" ? v.normalize("NFC")
  : Array.isArray(v) ? v.map(nfc)
  : (v && typeof v === "object") ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nfc(x)]))
  : v;

// Normalize body text conservatively: strip BOM, CRLF→LF, Unicode NFC, collapse a run of terminal
// newlines to one. Deliberately does NOT touch internal whitespace, blank lines, OR trailing
// horizontal whitespace — all three are Markdown-significant (indent = code block, blank line =
// paragraph break, two trailing spaces = a hard line break), so collapsing any of them could let a
// meaningful edit slip past the binding. Over-binding (a cosmetic edit invalidating an approval) fails
// SAFE — it forces a re-review; under-binding would trust content that renders differently.
export function normalizeBody(body) {
  return String(body).replace(/^﻿/, "").replace(/\r\n/g, "\n").normalize("NFC").replace(/\n+$/, "\n");
}

// The semantic subset of the frontmatter: every authored key except the non-semantic set. `id`/`title`
// are bound separately (as uid/title from the model), so they are dropped here — binding a mutable
// title twice, or a shim `id`, would make the digest depend on an alias rather than identity.
export function semanticFrontmatter(fm) {
  const out = {};
  if (fm && typeof fm === "object") for (const k of Object.keys(fm)) {
    if (NON_SEMANTIC_KEYS.has(k) || k === "id" || k === "title") continue;
    out[k] = fm[k];
  }
  return out;
}

// Compute the `bureau-page-v1` digest of a raw dossier. `uid`/`title` come from the model (opaque
// identity + display title); the body + remaining frontmatter come from the raw text. Returns a
// prefixed string so the digest is self-describing in the log and distinguishable from a span hash.
export function reviewDigest({ raw, uid, title }) {
  const { frontmatter, body } = splitFrontmatter(String(raw));
  const payload = {
    version: REVIEW_DIGEST_VERSION,
    uid: String(uid == null ? "" : uid).normalize("NFC"),
    title: String(title == null ? "" : title).normalize("NFC"),
    semanticFrontmatter: nfc(semanticFrontmatter(frontmatter)),
    normalizedBody: normalizeBody(body == null ? "" : body),
  };
  return "bureau-page-v1:" + createHash("sha256").update(canonicalJSON(payload, 0)).digest("hex");
}
