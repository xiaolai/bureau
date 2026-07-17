// runtime/pure — DOM-free render logic, unit-testable in Node. Concatenated into
// the browser bundle by src/build-runtime.mjs. No window/document here.
import { escapeHtml, escapeAttr } from "../shared/escape.mjs";
import { slugify } from "../shared/slug.mjs";

// identity: same NFC rule as the build/model (grill H3)
export function nfc(s) { return s == null ? s : String(s).normalize("NFC"); }

// [[target|label]] matcher with two capture groups (used by stripWiki)
export const WIKI_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

// render one [[wiki-link]] to its anchor HTML. Supports `[[Doc#Heading]]` (link to a
// heading) and `[[#Heading]]` (same doc — `selfId`). Pure + XSS-critical: label/title
// escaped; missing targets get no href (no javascript: URL).
export function makeResolve(docs, selfId) {
  return function resolve(target, label) {
    const hi = String(target).indexOf("#");
    const sameDoc = hi === 0;
    let docName = hi < 0 ? target : target.slice(0, hi);
    const anchor = hi < 0 ? "" : target.slice(hi + 1).trim();
    if (sameDoc && selfId != null) docName = String(selfId);
    const t = nfc(docName);
    // own-property test: a target like "constructor" must resolve as MISSING, not match an
    // inherited Object member (docs may be a plain object keyed by user titles).
    const exists = Object.prototype.hasOwnProperty.call(docs, t);
    let href = "";
    if (exists) { href = "#/" + encodeURIComponent(t); if (anchor) href += "?h=" + encodeURIComponent(slugify(anchor)); }
    const cls = exists ? "wikilink" : "wikilink wikilink--missing";
    const attr = exists ? 'href="' + href + '"' : 'aria-disabled="true"';
    const title = exists ? (anchor ? t + " › " + anchor : t) : (docName + " (missing)");
    const display = label || (sameDoc ? anchor : String(target).replace("#", " › "));
    return '<a class="' + cls + '" ' + attr + ' title="' + escapeAttr(title) +
      '"><span class="wikilink__bracket">[[</span>' + escapeHtml(display) +
      '<span class="wikilink__bracket">]]</span></a>';
  };
}

// strip [[..]] to plain names inside mermaid code (diagrams don't resolve links)
export function stripWiki(s) {
  return s.replace(WIKI_RE, (_, n, l) => (l || n).trim());
}

// inject flowchart node colors as in-diagram DSL (mermaid's local build only honors
// DSL, not page CSS). `palette` lets the theme drive node fill/stroke/text/edge so a
// dark theme's diagrams aren't stuck on the light default; dom.mjs reads it from CSS
// vars. Pure + DOM-free (palette is injected), so it stays Node-testable.
export function injectStyle(code, palette) {
  const p = palette || {};
  const fill = p.fill || "#efeae0", stroke = p.stroke || "#ddd6c8", color = p.color || "#22201b", link = p.link || "#b8b0a0";
  const c = stripWiki(code).replace(/\s+$/, "");
  if (!/^\s*(graph|flowchart)\b/.test(c)) return c;
  return c +
    "\n  classDef default fill:" + fill + ",stroke:" + stroke + ",color:" + color + ";" +
    "\n  linkStyle default stroke:" + link + ",stroke-width:1.4px;";
}

export function metaRow(meta) {
  if (!meta) return "";
  // `freshness` (current/needs-review/stale/modified) is the recursion-engine live badge — it rides
  // the same chip row but gets its own value class (meta-chip--fresh-<level>) for distinct colour.
  const base = ["type", "status", "words", "age"].filter((k) => meta[k])
    .map((k) => '<span class="meta-chip meta-chip--' + k + '">' + escapeHtml(meta[k]) + "</span>").join("");
  const fresh = meta.freshness
    ? '<span class="meta-chip meta-chip--freshness meta-chip--fresh-' + escapeHtml(String(meta.freshness)) + '">' + escapeHtml(String(meta.freshness)) + "</span>"
    : "";
  return base || fresh ? '<div class="doc-meta">' + base + fresh + "</div>" : "";
}

export const ICONS = {
  home: '<path d="M3 9.5 10 4l7 5.5M5 8.5V16h10V8.5"/>',
  user: '<circle cx="10" cy="7" r="3"/><path d="M4.5 16c.6-3 2.8-4.5 5.5-4.5S15 13 15.5 16"/>',
  globe: '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2 2.2 2 10.8 0 13M10 3.5c-2 2.2-2 10.8 0 13"/>',
  file: '<path d="M6 3h5l3 3v11H6z"/><path d="M11 3v3h3"/>',
  book: '<path d="M5 4h5v12H6a1 1 0 0 1-1-1z"/><path d="M15 4h-5v12h4a1 1 0 0 0 1-1z"/>',
  share: '<circle cx="6" cy="10" r="2"/><circle cx="14" cy="5" r="2"/><circle cx="14" cy="15" r="2"/><path d="M7.8 9 12.3 6M7.8 11l4.5 3"/>',
  clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4l3 2"/>',
  seal: '<rect x="4.5" y="4.5" width="11" height="11" rx="1.5"/><path d="M8 8h4M8 10.5h4M8 13h2.5"/>',
  swords: '<path d="M4 4l7 7M13 4l3 0 0 3-7 7M4 13l3 3M14 13l-3 3"/>',
  heart: '<path d="M10 16S4 12 4 7.8A2.8 2.8 0 0 1 10 6a2.8 2.8 0 0 1 6 1.8C16 12 10 16 10 16z"/>',
};
export function icon(n) {
  // own-property only: a name like "constructor"/"__proto__"/"toString" must fall back to the
  // default glyph, not resolve to an inherited Object member (which would inject junk into the SVG).
  const glyph = Object.prototype.hasOwnProperty.call(ICONS, n) ? ICONS[n] : ICONS.file;
  return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + glyph + "</svg>";
}
