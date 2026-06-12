// shared/slug — heading-anchor slugs. Used at build for heading ids and for the
// `?h=` target of `[[Note#Heading]]` wiki-links, so both sides agree. Unicode-aware
// (CJK headings keep their characters). Concatenated into the bundle by build-runtime.
// PLAIN-TEXT slugger: callers that pass rendered HTML (e.g. addHeadingIds) must strip tags
// FIRST. Stripping `<...>` here would also eat literal `A < B` heading text and desync the
// anchor from the wiki-link slug (which is always plain text), so it's intentionally absent.
export function slugify(s) {
  return String(s == null ? "" : s)
    .normalize("NFC")                        // composed/decomposed forms → one slug
    .toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")       // keep letters/numbers/space/_/-
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
