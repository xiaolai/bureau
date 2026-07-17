// services/sanitize — untrusted-content boundary (PRD P7). Author HTML doc bodies
// are sanitized HERE at build time (sanitize-html, Node), then shipped pre-rendered
// in content.js; the shell also emits the CSP. The escapers live in shared/ so the
// browser runtime bundle uses the SAME code.
import sanitizeHtmlLib from "sanitize-html";

export { escapeHtml, escapeAttr } from "../shared/escape.mjs";

// Tags an author may use in a doc body. Adds h1/h2/img/figure/details/section/etc.
// to sanitize-html's defaults; the viz/mermaid containers are plain <div> + data-*.
const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp", "var", "b", "strong", "i", "em", "u",
  "s", "del", "ins", "mark", "small", "sub", "sup", "abbr", "cite", "q", "br", "hr",
  "wbr", "span", "div", "section", "article", "aside", "header", "footer", "nav",
  "main", "figure", "figcaption", "img", "picture", "source", "table", "caption",
  "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "details", "summary",
  "time", "address", "dfn",
];

const ALLOWED_ATTRS = {
  "*": ["class", "id", "style", "title", "lang", "dir", "data-*", "aria-disabled", "role", "aria-label"],
  // (style is kept but its properties are constrained by ALLOWED_STYLES below)
  a: ["href", "class", "title", "aria-disabled", "data-wiki", "rel", "target"],
  img: ["src", "alt", "width", "height", "loading"],
  source: ["src", "srcset", "type", "media"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "scope"],
  col: ["span"],
  time: ["datetime"],
};

// Sanitize one author HTML doc body. Drops scripts, event handlers, and unknown
// tags/attrs; keeps the viz/mermaid containers, wiki-link anchors, and data-*.
// Link hrefs: http/https/mailto + relative/hash only. `data:` is allowed solely on
// <img> (for inline images) — never on <a>, so a `data:text/html` link can't ship.
// inline `style` is kept, but only COSMETIC properties — a board rendered from author/AI content
// must not be able to hijack layout (position:fixed; inset:0 to cover the UI, transform, z-index).
// sanitize-html re-serializes each declaration, so values can't inject; the risk is the property.
const COSMETIC = [/^.*$/];
const ALLOWED_STYLES = {
  "*": {
    color: COSMETIC, "background-color": COSMETIC, "font-weight": COSMETIC, "font-style": COSMETIC,
    "font-size": COSMETIC, "text-align": COSMETIC, "text-decoration": COSMETIC, "font-family": COSMETIC,
  },
};

export function sanitizeBody(html) {
  return sanitizeHtmlLib(String(html == null ? "" : html), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "mailto"],
    // offline artifact: the CSP is `img-src 'self' data:`, so a remote src only ever renders as a
    // broken image — strip it here (data: + relative/local assets remain) so the HTML matches reality.
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    transformTags: {
      // a target=_blank link lets the opened tab reach window.opener — force rel to close the
      // tabnabbing/opener vector on any anchor the author points at a new browsing context.
      a: (tagName, attribs) => (attribs.target ? { tagName, attribs: { ...attribs, rel: "noopener noreferrer" } } : { tagName, attribs }),
    },
  });
}

// Content-Security-Policy <meta> for the offline artifact. Fully local: no remote
// origins (fonts are system-stack, grill M4), no network connections (connect-src
// 'none' blocks exfiltration even if a render layer is later compromised). Inline
// styles are allowed because app.js sets element.style for pan/zoom and mermaid/
// ECharts emit inline styles. `'wasm-unsafe-eval'` is the NARROW token that lets the
// Graphviz-in-WASM DOT engine (viz.min.js) compile — it permits WebAssembly ONLY,
// never JS eval()/new Function(), so the no-arbitrary-script guarantee still holds.
export function cspMeta() {
  const policy = [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "connect-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  return '<meta http-equiv="Content-Security-Policy" content="' + policy + '" />';
}
