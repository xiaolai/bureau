// core/parse — the ONE doc reader (grill H3: no second parser). Docs are HTML
// fragments; metadata rides on a root element's data-* (or an optional leading
// `---` YAML block), wiki-links are `<a data-wiki>` or bare `[[Target]]` in text.
// node-html-parser does the robust parse for the model; build-time link resolution
// is a pre/code-protected string transform (kept consistent with what the model
// counts as a link). Still keeps splitFrontmatter for the optional frontmatter +
// for _types/*.html schemas.
import { parse as parseHTML } from "node-html-parser";
import MarkdownIt from "markdown-it";
import { escapeHtml, escapeAttr } from "../shared/escape.mjs";
import { slugify } from "../shared/slug.mjs";

const WIKI_RE = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
// two-group form for resolution (target, label)
const WIKI_RE2 = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
// link form for resolveLinks — must NOT match `![[..]]` (that's an embed, handled later)
const WIKI_RE2_LINK = /(?<!!)\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

// frontmatter keys that are attributes/meta, not typed edges. `rests_on` is reserved here
// because it is handled specially (restsOnEdges) — it carries span/because, which the generic
// `[[..]] ⇒ edge` rule can't represent — not because it isn't an edge.
const FM_RESERVED = new Set(["title", "group", "icon", "type", "status", "updated", "age", "words", "home", "subtitle", "id", "trust", "freeze", "kind", "claim", "rests_on"]);
// data-* keys on the root that are NOT typed relations
const DATA_RESERVED = new Set(["title", "group", "icon", "updated", "type", "status", "words", "age", "wiki", "kind", "format", "id", "trust", "freeze", "claim"]);
// elements whose text is literal (links inside are NOT edges, mirroring the renderer)
const RAW_TEXT = new Set(["PRE", "CODE", "SCRIPT", "STYLE", "TEXTAREA"]);
const META_CHIP_KEYS = ["type", "status", "words", "age"];
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i; // image-embed extensions

// All non-empty [[targets]] in a string. A trailing `#heading` is stripped (the doc
// is the target, not "Doc#Heading"), label dropped, blanks dropped (grill L5).
export function extractLinks(str) {
  const out = [];
  let m;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(String(str)))) {
    const t = m[1].split("#")[0].trim();
    if (t) out.push(t);
  }
  return out;
}

// Document links in a BODY for the graph/health/backlinks model: like extractLinks but
// also (a) recognizes `![[..]]` embeds — image embeds are NOT doc links, note embeds
// ARE — and (b) strips the `#heading` anchor. Mirrors what the renderer treats as edges.
const BODYLINK_RE = /(!)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
export function extractBodyLinks(str) {
  const out = [];
  let m;
  BODYLINK_RE.lastIndex = 0;
  while ((m = BODYLINK_RE.exec(String(str)))) {
    const t = (m[2] || "").trim();
    if (!t) continue;                          // [[#anchor]] / ![[#..]] — no doc target
    if (m[1] && IMG_EXT.test(t)) continue;     // image embed — not a document link
    out.push(t);
  }
  return out;
}

// run `fn` over `html` with <pre>/<code>/comments masked out, so transforms (embeds,
// links) never fire inside literal code examples. Strips reserved sentinel chars first.
const RAW_BLOCK = /<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>|<!--[\s\S]*?-->/gi;
export function replaceOutsideRaw(html, fn) {
  const slots = [];
  let h = String(html).replace(/[\uE000\uE001]/g, "").replace(RAW_BLOCK, (m) => { slots.push(m); return "\uE000" + (slots.length - 1) + "\uE001"; });
  h = fn(h);
  return h.replace(/(\d+)/g, (_, i) => slots[+i]);
}

function parseScalar(raw) {
  const v = raw.trim();
  // inline list `[a, b]` — but NOT `[[wiki-links]]` (those stay raw for link extraction)
  if (v.startsWith("[") && v.endsWith("]") && !v.includes("[[")) {
    return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
  }
  return v;
}

// The frontmatter grammar this parser can actually represent: FLAT `key: value` lines.
// A key is a plain identifier — anything else is a line we misread, not a key.
const FM_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// The two YAML constructs we refuse rather than misread. A block-scalar HEADER is the marker
// alone (`|`, `>`, with optional chomp/indent indicators and trailing comment) — not any value
// that merely starts with `|`. An anchor is `&name`. Deliberately NOT here: `*alias` (anchors
// are rejected, so an alias can't resolve — `*emph*` is just text) and `-1` / `--flag`.
const BLOCK_SCALAR = /^[|>][+-]?[0-9]*[+-]?\s*(#.*)?$/;
const ANCHOR = /^&\S/;

// Split a doc into { frontmatter: {key: value}, body }. Throws on duplicate keys, on a
// key we can't represent, and on YAML the flat grammar would silently mangle.
//
// Why it throws instead of skipping: this is a line-by-line `indexOf(":")` reader, not a
// YAML engine. Fed a nested block — the multi-line list every author reaches for —
//
//   sources:
//     - "session 978074e1 (RT-03 pilot; theorist: Wayne)"
//
// it used to drop the list (`sources` → "") AND harvest a bogus key from the item's own
// colon (`- "session … theorist` → `Wayne)"`), so two such items could even collide into
// a "duplicate key" crash. Silent corruption of the very field that carries provenance.
// The flat grammar is the contract; a block that isn't flat is now a loud, actionable error.
export function splitFrontmatter(raw) {
  const text = String(raw).replace(/^﻿/, ""); // strip BOM (grill M15)
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: text };
  const fm = Object.create(null); // null-proto: a `__proto__:`/`constructor:` frontmatter key is data, not a prototype mutation
  const lines = m[1].split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;             // blank
    if (/^\s*#/.test(line)) continue;       // comment
    // A continuation line reaching the top level belongs to no key: a nested map, a block
    // scalar's text, or a stray list item. Not representable — say so instead of guessing.
    if (/^\s/.test(line) || /^-\s/.test(line)) throw new Error(unsupportedFm(line));
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    if (!FM_KEY.test(key)) throw new Error(unsupportedFm(line));
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      throw new Error('duplicate frontmatter key "' + key + '"');
    }
    const inline = line.slice(i + 1).trim();
    // `key: |` / `key: >` (a block-scalar header) and `key: &anchor` are YAML we do not implement;
    // reading them as the literal strings "|" or "&anchor …" would be a silent misread. Keep the
    // guard TIGHT: only the actual YAML forms. A value like `*emph*` or `-1` is ordinary text —
    // and since anchors are rejected, a `*alias` can never refer to anything, so it is text too.
    if (inline !== "" && (BLOCK_SCALAR.test(inline) || ANCHOR.test(inline))) throw new Error(unsupportedFm(line));
    if (inline !== "") { fm[key] = parseScalar(inline); continue; }
    // A bare `key:` opens a multi-line sequence — the idiom every author reaches for:
    //     sources:
    //       - "[[session a1b2c3d4 · 2026-06-10]]"
    // Items stay STRINGS (no YAML type coercion: no `2026-06-12` → Date, no `no` → false).
    // A following line that isn't a `- ` item ends the block; if it's indented, the next
    // pass throws — so a nested map or block scalar is still rejected, not half-parsed.
    const items = [];
    while (li + 1 < lines.length) {
      const it = lines[li + 1].match(/^[ \t]*-[ \t]+(.*)$/);
      if (!it) break;
      items.push(seqItem(it[1], lines[li + 1]));
      li++;
    }
    fm[key] = items.length ? items : "";
  }
  return { frontmatter: fm, body: m[2] };
}

// One sequence item → a string. QUOTED wins: inside quotes a `:` is plain text, which is what
// makes real provenance strings ("… theorist: Wayne") work. UNQUOTED, a `: ` makes it a YAML
// *mapping* (`- theorist: Wayne` is a map, not a string) — we don't implement maps, so reading
// it as text would be the same silent misread this parser exists to stop. Reject it instead.
function seqItem(raw, line) {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length > 1 && v[v.length - 1] === q) return v.slice(1, -1);
  // the ONE nested shape we accept: a bounded inline-flow map `{ key: "v", … }` (rests_on object
  // edge, ADR-0001). It bypasses the mapping guard below precisely because it is explicit and
  // recognizable — not a `- key: value` that could be a silent misread.
  if (v.startsWith("{") && v.endsWith("}")) return parseInlineMap(v.slice(1, -1), line);
  if (BLOCK_SCALAR.test(v) || ANCHOR.test(v)) throw new Error(unsupportedFm(line));
  if (/^-(\s|$)/.test(v)) throw new Error(unsupportedFm(line));  // `- - x` → a nested sequence
  if (/:(\s|$)/.test(v)) throw new Error(unsupportedFm(line));   // `- key: value` → a mapping
  return v;                                                      // `-1`, `--flag`, `*emph*` are just text
}

function unsupportedFm(line) {
  return 'unsupported frontmatter line: "' + line.trim() + '"\n' +
    "  Frontmatter supports flat `key: value` lines, inline lists (`key: [a, b]`), and multi-line\n" +
    "  lists of scalars:\n" +
    "      sources:\n" +
    '        - "[[session <id> · <date>]]"\n' +
    "  A list item containing a colon must be QUOTED — `- \"theorist: Wayne\"`. Unquoted, `- key: value`\n" +
    "  is a YAML mapping, which is not supported (nor are block scalars `|` / `>`, or anchors).";
}

// ── HTML doc model ────────────────────────────────────────────────────────────
// A relation value names edge targets ONLY via `[[A]] [[B]]` (mirrors the old
// frontmatter rule: `[[..]]` ⇒ typed edge; anything else ⇒ a scalar/list attribute).
export function relTargets(value) {
  const parts = Array.isArray(value) ? value : [value]; // a list value (inline or multi-line) names one target per item
  const out = [];
  for (const p of parts) {
    const s = String(p == null ? "" : p);
    if (s.includes("[[")) out.push(...extractLinks(s));
  }
  return out;
}

// a non-relation attribute value: `[a, b]` → array (for the schema single/list check),
// otherwise the scalar string (or an already-parsed frontmatter value).
function parseAttrValue(v) {
  if (Array.isArray(v)) return v;
  const s = String(v == null ? "" : v).trim();
  if (s.startsWith("[") && s.endsWith("]") && !s.includes("[[")) return s.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
  return v;
}

// ── engine: author-anchored spans + object edges (recursion-engine data model, ADR-0001) ──
// A cited span is an author-anchored `^anchor` block marker terminating a line (Obsidian block-ref
// convention). The span's content is the contiguous non-blank line block ending at the anchor line,
// with the trailing `^anchor` token removed. Deterministic; format-agnostic (operates on the raw
// body text). A `^` mid-line (e.g. "2^8") is never a span — only end-of-line anchors count.
const SPAN_ANCHOR = /(^|[ \t])\^([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*$/;
export function extractSpans(rawBody) {
  const lines = String(rawBody == null ? "" : rawBody).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SPAN_ANCHOR);
    if (!m) continue;
    let start = i;
    while (start > 0 && lines[start - 1].trim() !== "") start--; // walk up to a blank line / start
    const block = lines.slice(start, i + 1).join("\n");
    const text = block.replace(SPAN_ANCHOR, "").trim(); // drop the trailing ^anchor token for hashing
    out.push({ anchor: m[2], text });
  }
  return out;
}

// split `s` on `delim`, but only OUTSIDE single/double quotes — so a comma or colon inside a
// quoted `because:` value is literal. Used only for the bounded inline-flow map below.
function splitOutsideQuotes(s, delim) {
  const out = []; let cur = "", q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function firstColonOutsideQuotes(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) { const ch = s[i]; if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === ":") return i; }
  return -1;
}
// Parse a BOUNDED inline-flow map body (the text between `{` and `}`): `key: "value", key: value`.
// This is the ONE nested shape the frontmatter grammar accepts (ADR-0001, Decision B); anything
// else still throws via the flat-grammar guards. Keys are plain identifiers; values are quoted
// strings or bare tokens. Not a general YAML flow-map — no nesting, no lists.
export function parseInlineMap(body, line) {
  const obj = Object.create(null);
  for (const part of splitOutsideQuotes(body, ",")) {
    if (!part.trim()) continue;
    const ci = firstColonOutsideQuotes(part);
    if (ci < 0) throw new Error(unsupportedFm(line));
    const k = part.slice(0, ci).trim();
    if (!FM_KEY.test(k)) throw new Error(unsupportedFm(line));
    let v = part.slice(ci + 1).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length > 1 && v[v.length - 1] === q) v = v.slice(1, -1);
    obj[k] = v;
  }
  return obj;
}

// rests_on: string | {page, span, because} list → edges. An OBJECT item is a TRACKED edge — it has
// a `span` to anchor the deterministic gate on. A bare STRING is an UNTRACKED edge (recorded, but
// outside the sound-gate guarantee — no span/justification to key a verdict on). Order preserved.
export function restsOnEdges(value) {
  const out = [];
  for (let raw of (Array.isArray(value) ? value : [value])) {
    let item = raw;
    if (typeof item === "string") {
      const s = item.trim();
      if (s.startsWith("{") && s.endsWith("}")) item = parseInlineMap(s.slice(1, -1), s);
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const page = extractLinks(String(item.page == null ? "" : item.page))[0];
      if (!page) throw new Error('rests_on object edge needs page: "[[Target]]" (got: ' + JSON.stringify(item) + ")");
      out.push({ target: page, edgeType: "rests_on", span: item.span ? String(item.span) : null, because: item.because ? String(item.because) : null, tracked: !!item.span });
    } else {
      for (const t of extractLinks(String(item == null ? "" : item))) out.push({ target: t, edgeType: "rests_on", span: null, because: null, tracked: false });
    }
  }
  return out;
}

function isInRawText(node) {
  // start at the node ITSELF so `<code data-wiki="X">` (a raw element carrying the attr)
  // is excluded too, not only descendants of a raw block. Text nodes have no tagName, so
  // the self-check is a harmless no-op for them and the ancestor walk still applies.
  for (let p = node; p; p = p.parentNode) if (p.tagName && RAW_TEXT.has(p.tagName)) return true;
  return false;
}

// Parse one HTML-fragment doc → { meta, metaChips, attrs, edges, bodyLinks, body }.
// Metadata is read from the root metadata element (the one carrying data-group, else
// the first <article>/<section>, else the first element); an optional leading `---`
// YAML block overrides element data-*. Title falls back to the first <h1>.
export function parseHtmlDoc(raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = frontmatter || {};
  const root = parseHTML(body, { comment: false });
  const metaEl = root.querySelector("[data-group]") || root.querySelector("article, section") ||
    root.childNodes.find((n) => n.nodeType === 1) || null;
  const dget = (k) => (metaEl ? metaEl.getAttribute("data-" + k) : undefined);
  const fmStr = (k) => (fm[k] != null ? String(fm[k]) : undefined);
  const h1 = root.querySelector("h1");

  const meta = {
    title: fmStr("title") ?? dget("title") ?? (h1 ? h1.text.trim() : "") ?? "",
    group: fmStr("group") ?? dget("group") ?? null,
    icon: fmStr("icon") ?? dget("icon") ?? "file",
    updated: fmStr("updated") ?? dget("updated") ?? null,
    // recursion-engine authored meta (ADR-0001): opaque id + the four-field state (trust/freeze)
    id: fmStr("id") ?? dget("id") ?? null,
    trust: fmStr("trust") ?? dget("trust") ?? null,
    freeze: fmStr("freeze") ?? dget("freeze") ?? null,
    kind: fmStr("kind") ?? dget("kind") ?? null,
    claim: fmStr("claim") ?? dget("claim") ?? null,
  };
  const metaChips = {};
  for (const k of META_CHIP_KEYS) { const v = fm[k] != null ? fm[k] : dget(k); if (v) metaChips[k] = v; }

  const edges = [], attrs = Object.create(null); // null-proto: a `data-__proto__`/relation key is data, not a prototype mutation
  const addRel = (key, value) => {
    const ts = relTargets(value);
    if (ts.length) { for (const t of ts) edges.push({ target: t, edgeType: key }); return; }
    if (value != null && value !== "") attrs[key] = parseAttrValue(value);
  };
  for (const k of Object.keys(fm)) { if (!FM_RESERVED.has(k)) addRel(k, fm[k]); }
  if (metaEl) for (const a of Object.keys(metaEl.attributes || {})) {
    if (!a.startsWith("data-")) continue;
    const key = a.slice(5);
    if (DATA_RESERVED.has(key) || Object.prototype.hasOwnProperty.call(attrs, key)) continue; // frontmatter wins
    addRel(key, metaEl.getAttribute(a));
  }
  if (fm.rests_on != null) for (const e of restsOnEdges(fm.rests_on)) edges.push(e); // object/tracked edges (ADR-0001)

  // body links (graph/health/backlinks): [[..]] / note-![[..]] in text outside raw-text
  // (anchors stripped, image embeds excluded) + [data-wiki] targets.
  const seen = [];
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { if (!isInRawText(ch)) for (const t of extractBodyLinks(decodeEntities(ch.rawText))) seen.push(t); }
      else if (ch.nodeType === 1) walk(ch);
    }
  };
  walk(root);
  root.querySelectorAll("[data-wiki]").forEach((el) => { if (!isInRawText(el)) { const t = (el.getAttribute("data-wiki") || "").split("#")[0].trim(); if (t) seen.push(t); } });

  return { meta, metaChips, attrs, edges, bodyLinks: seen, body, spans: extractSpans(body) };
}

// ── Markdown / Obsidian lane ──────────────────────────────────────────────────
// Markdown is a SOURCE format; it's rendered to HTML at BUILD time (markdown-it is a
// build-only dep, never shipped to the browser). `[[wiki-links]]` survive the render
// as text and are resolved by resolveLinks downstream (same as HTML docs). Raw HTML
// passes through (sanitized later) — the HTML escape hatch inside markdown. Fenced
// ```mermaid / ```viz / ```chart|table|graph blocks map to the runtime widget divs.
let _md = null;
function mdEngine() {
  if (_md) return _md;
  const m = MarkdownIt({ html: true, linkify: true, typographer: true, breaks: false });
  const defaultFence = m.renderer.rules.fence || ((t, i, o, e, s) => s.renderToken(t, i, o));
  m.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const tk = tokens[idx];
    const parts = (tk.info || "").trim().split(/\s+/);
    const tag = (parts[0] || "").toLowerCase();
    const content = escapeHtml(tk.content.replace(/\n+$/, ""));
    if (tag === "mermaid") return '<div class="mermaid">' + content + "</div>\n";
    if (tag === "dot") {
      // Graphviz DOT — laid out + drawn hand-sketched at runtime (Viz WASM + rough.js),
      // same lane as ```mermaid. `engine=` picks the layout (dot|neato|fdp|circo|twopi|…),
      // `roughness=` tunes the sketch. Source ships escaped inside a plain div (survives
      // the build sanitizer); dom.js reads it back and renders after sanitize.
      const kv = {};
      for (const p of parts.slice(1)) { const i = p.indexOf("="); if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1); else kv[p] = ""; }
      let attrs = "";
      for (const k of ["engine", "roughness"]) if (kv[k]) attrs += " data-" + k + '="' + escapeAttr(kv[k]) + '"';
      return '<div class="dot"' + attrs + ">" + content + "</div>\n";
    }
    if (tag === "tabs") {
      // ```tabs with `=== Title` markers per panel; each panel body is rendered as markdown
      // (same engine → wiki-links, tags, tables work). Runtime hydrates into an ARIA tablist.
      const depth = (env && env._tabsDepth) || 0;
      if (depth >= 3) return defaultFence(tokens, idx, options, env, self); // cap nested-tabs recursion
      const panels = [];
      let cur = null, preamble = false, inFence = null;
      for (const line of tk.content.replace(/\n+$/, "").split("\n")) {
        const fb = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (inFence) {                                                   // inside a nested code fence — never a marker
          // a CLOSE is the same fence char, ≥ length, and NOTHING but trailing whitespace after it
          const fc = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
          if (fc && fc[1][0] === inFence.ch && fc[1].length >= inFence.len) inFence = null;
          if (cur) cur.body.push(line); else if (line.trim()) preamble = true;
          continue;
        }
        if (fb) { inFence = { ch: fb[1][0], len: fb[1].length }; if (cur) cur.body.push(line); else if (line.trim()) preamble = true; continue; }
        const mt = /^={3,}\s+(.+?)\s*$/.exec(line);
        const title = mt && mt[1].trim();
        if (title) { cur = { title, body: [] }; panels.push(cur); }      // blank titles are not markers
        else if (cur) cur.body.push(line);
        else if (line.trim()) preamble = true;                           // nonblank content before any panel
      }
      // malformed (no panels, or content would be silently dropped) → plain code block, lose nothing
      if (!panels.length || preamble) return defaultFence(tokens, idx, options, env, self);
      const childEnv = Object.assign({}, env, { _tabsDepth: depth + 1 });
      let out = '<div class="tabs">';
      for (const p of panels) out += '<section class="tab-panel" role="tabpanel" data-tab="' +
        escapeAttr(p.title) + '">' + m.render(p.body.join("\n"), childEnv) + "</section>";
      return out + "</div>\n";
    }
    if (tag === "viz" || tag === "chart" || tag === "table" || tag === "graph") {
      const kv = {};
      for (const p of parts.slice(1)) { const i = p.indexOf("="); if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1); else kv[p] = ""; }
      if (tag !== "viz") kv.type = tag;
      let attrs = "";
      for (const k of ["type", "kind", "format", "title", "layout", "height"]) if (kv[k]) attrs += " data-" + k + '="' + escapeAttr(kv[k]) + '"';
      for (const k of ["stack", "smooth", "directed"]) if (k in kv) attrs += " data-" + k;
      return '<div class="viz"' + attrs + ">" + content + "</div>\n";
    }
    return defaultFence(tokens, idx, options, env, self);
  };
  // #tags — inline rule (skips code spans, and `[[#anchor]]` since `#` there follows `[`)
  m.inline.ruler.before("text", "wb_tag", function (state, silent) {
    const pos = state.pos, src = state.src;
    if (src.charCodeAt(pos) !== 0x23) return false; // '#'
    if (pos > 0) { const p = src.charCodeAt(pos - 1); if (p !== 0x20 && p !== 0x09 && p !== 0x0a) return false; } // must follow ws/start
    const mm = src.slice(pos + 1).match(/^[\p{L}][\p{L}\p{N}_/-]*/u);
    if (!mm) return false;
    if (!silent) { const tok = state.push("wb_tag", "", 0); tok.content = mm[0]; }
    state.pos = pos + 1 + mm[0].length;
    return true;
  });
  m.renderer.rules.wb_tag = (tokens, idx) => '<span class="tag" data-tag="' + escapeAttr(tokens[idx].content) + '">#' + escapeHtml(tokens[idx].content) + "</span>";
  _md = m;
  return m;
}

// Obsidian callouts: a blockquote whose first paragraph starts `[!type] Title`
// → <div class="callout callout-type"> with a title + body (keeps inner blocks).
function renderCallouts(html) {
  const s = String(html), OPEN = "<blockquote>", CLOSE = "</blockquote>";
  let out = "", i = 0;
  while (i < s.length) {
    const start = s.indexOf(OPEN, i);
    if (start < 0) { out += s.slice(i); break; }
    out += s.slice(i, start);
    // find the MATCHING close by depth (so nested blockquotes don't truncate the callout)
    let depth = 0, j = start, closed = false;
    while (j < s.length) {
      const no = s.indexOf(OPEN, j), nc = s.indexOf(CLOSE, j);
      if (nc < 0) { j = s.length; break; }
      if (no >= 0 && no < nc) { depth++; j = no + OPEN.length; }
      else { depth--; j = nc + CLOSE.length; if (depth === 0) { closed = true; break; } }
    }
    const block = s.slice(start, j);
    // unbalanced/unclosed blockquote → emit verbatim, never strip a non-existent close tag
    const mm = closed && block.slice(OPEN.length, block.length - CLOSE.length).match(/^\s*<p>\s*\[!([\w-]+)\][+-]?[ \t]*([^\n<]*)/);
    if (mm) {
      const inner = block.slice(OPEN.length, block.length - CLOSE.length);
      const type = mm[1].toLowerCase();
      // mm[2] comes from already-escaped markdown-it output; decode→escape avoids double-escaping (A & B)
      const title = escapeHtml(decodeEntities(mm[2].trim())) || (type.charAt(0).toUpperCase() + type.slice(1));
      const body = inner.replace(/^\s*<p>\s*\[![\w-]+\][+-]?[ \t]*[^\n<]*\n?/, "<p>").replace(/^\s*<p>\s*<\/p>\s*/, "");
      out += '<div class="callout callout-' + type + '"><div class="callout-title">' + title + '</div><div class="callout-body">' + body + "</div></div>";
    } else { out += block; }
    i = j;
  }
  return out;
}

export function markdownToHtml(src) {
  return renderCallouts(mdEngine().render(String(src == null ? "" : src)));
}

// add slugged ids to headings (for [[Note#heading]] scroll targets + section embeds);
// respects an author-provided id. Build-time; deterministic per document.
export function addHeadingIds(html) {
  const s = String(html);
  const used = new Set();
  // reserve existing ids — but scan a copy with <pre>/<code>/comments masked, so a literal
  // `id="x"` shown inside a code example isn't mistaken for a real DOM id.
  const idScanSrc = s.replace(RAW_BLOCK, "");
  let am; const idRe = /\bid\s*=\s*("|')([\s\S]*?)\1/g;
  while ((am = idRe.exec(idScanSrc))) used.add(am[2]);
  return s.replace(/<h([1-6])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g, (m, lvl, attrs, inner) => {
    if (/\bid\s*=/.test(attrs)) return m;
    // strip inline tags (<em> etc.) THEN decode entities, so the heading id matches the slug
    // makeResolve derives from the plain wiki-link text: "A &amp; B" / "A <em>B</em>" → "a-b".
    const base = slugify(decodeEntities(stripTags(inner))) || "section";
    let id = base, i = 2;
    while (used.has(id)) id = base + "-" + i++;
    used.add(id);
    return "<h" + lvl + attrs + ' id="' + id + '">' + inner + "</h" + lvl + ">";
  });
}

// image embeds: `![[name.ext]]` (image extension) → <img>, resolved against the asset
// index. Non-image `![[..]]` is left for note transclusion (build). Skips <pre>/<code>
// AND restricts to text gaps (replaceInGaps) so a marker inside an attribute value isn't
// rewritten into the tag.
export function resolveImageEmbeds(html, assetIndex) {
  return replaceOutsideRaw(html, (h) => replaceInGaps(h, (gap) => gap.replace(/!\[\[([^\]|#]+?)(?:\|([^\]]*))?\]\]/g, (m, target, label) => {
    const name = decodeEntities(String(target).trim()); // `![[a&amp;b.png]]` must match asset "a&b.png"
    if (!IMG_EXT.test(name)) return m;
    const url = (assetIndex && (assetIndex[name] || assetIndex[name.split("/").pop()])) || "";
    if (!url) return '<span class="wb-embed-missing">⛔ missing image: ' + escapeHtml(name) + "</span>";
    return '<img class="wb-embed-img" src="' + escapeAttr(url) + '" alt="' + escapeAttr((label || name).trim()) + '" loading="lazy">';
  })));
}

// strip markdown code so links/headings inside it aren't counted as edges OR picked up as
// the title fallback. Line-based (CommonMark-ish): a ``` / ~~~ fence (3+, ≤3 leading spaces)
// opens a block closed by a same-char fence of ≥ the opening length; an UNCLOSED fence runs
// to EOF. Inline backtick spans are stripped on non-fence lines. (markdown-it still renders;
// this only feeds graph-edge extraction + the heading-title fallback.)
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
function stripMdCode(s) {
  const lines = String(s).split("\n");
  let fence = null; // { ch, len }
  const out = lines.map((line) => {
    if (fence) {
      const c = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      return ""; // drop the code line (and the closing fence line)
    }
    const o = line.match(FENCE_OPEN);
    if (o) { fence = { ch: o[1][0], len: o[1].length }; return ""; }
    return line.replace(/(`+)[^`]*?\1/g, ""); // inline spans on a normal line
  });
  return out.join("\n");
}

// Markdown prose reduced to just its RENDERED TEXT: markdown code (fences + inline spans),
// raw HTML <pre>/<code>/comments, AND the markup of every other HTML tag are removed, leaving
// only the text a reader sees. markdown allows raw HTML, and the renderer resolves links only
// in rendered text — so a `[[..]]` that lives inside a tag (a code sample, OR an attribute like
// `<span title="[[X]]">`) is never drawn as a link. Counting it would forge an edge the page
// doesn't have — a false provenance link the reader can't click. Stripping tag markup (not the
// text between tags) leaves exactly the links the renderer would draw. This is only for edge/
// title extraction; the real body is rendered separately by markdownToHtml.
function stripMdLiteral(s) {
  return stripMdCode(s)
    .replace(RAW_BLOCK, " ")                  // <pre>/<code>/comment BLOCKS (content and all)
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ");     // real HTML tag MARKUP only — a `<` that opens an actual
                                              // tag (letter or /letter after it). This drops attribute
                                              // text like `title="[[X]]"` while KEEPING prose links: in
                                              // `2 < 3 and [[Body]] > 1` the `<` isn't a tag, so [[Body]]
                                              // survives (markdown-it renders it as a link there too).
}

// Parse one markdown/Obsidian doc → the SAME shape as parseHtmlDoc. Metadata comes
// from YAML frontmatter (Obsidian-style); title falls back to the first ATX heading;
// typed relations are frontmatter keys with `[[..]]` values; body links are `[[..]]`
// outside code. The markdown `body` is rendered to HTML at build (markdownToHtml).
export function parseMarkdownDoc(raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = frontmatter || {};
  const fmStr = (k) => (fm[k] != null ? String(fm[k]) : undefined);
  const prose = stripMdLiteral(body);
  let title = fmStr("title");
  if (title == null) { const h = prose.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m); title = h ? h[1].trim() : ""; }
  const meta = {
    title: title || "", group: fmStr("group") ?? null, icon: fmStr("icon") ?? "file", updated: fmStr("updated") ?? null,
    id: fmStr("id") ?? null, trust: fmStr("trust") ?? null, freeze: fmStr("freeze") ?? null, kind: fmStr("kind") ?? null, claim: fmStr("claim") ?? null,
  };
  const metaChips = {};
  for (const k of META_CHIP_KEYS) if (fm[k] != null) metaChips[k] = String(fm[k]);
  const edges = [], attrs = Object.create(null); // null-proto: a `data-__proto__`/relation key is data, not a prototype mutation
  const addRel = (key, value) => {
    const ts = relTargets(value);
    if (ts.length) { for (const t of ts) edges.push({ target: t, edgeType: key }); return; }
    if (value != null && value !== "") attrs[key] = parseAttrValue(value);
  };
  for (const k of Object.keys(fm)) { if (!FM_RESERVED.has(k)) addRel(k, fm[k]); }
  if (fm.rests_on != null) for (const e of restsOnEdges(fm.rests_on)) edges.push(e); // object/tracked edges (ADR-0001)
  return { meta, metaChips, attrs, edges, bodyLinks: extractBodyLinks(prose), body, spans: extractSpans(body) };
}

// ── build-time wiki-link resolution (HTML) ─────────────────────────────────────
// `resolve(target, label)` → anchor HTML (reuses runtime makeResolve). Protects
// <pre>/<code>/comments, resolves <a data-wiki> elements and bare [[Target|label]]
// in text. Author HTML is otherwise preserved verbatim.
const PROTECT = RAW_BLOCK; // same pre/code/comment mask used by resolveImageEmbeds
// data-wiki anchor: quoted ("/') OR unquoted value (matches what node-html-parser
// accepts in the model, so resolution doesn't skip a link the model counted)
const A_WIKI = /<a\b[^>]*?\bdata-wiki\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi;
const TAG = /<[^>]+>/g;
const SENTINEL = /[\uE000\uE001]/g; // private-use chars reserved for protect/restore

// decode the common named entities + numeric (&#38; / &#x26;) so model + resolver agree
const cp = (n) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�"); // guard RangeError on out-of-range entities
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
const stripTags = (s) => String(s).replace(TAG, "").trim();

// run `fn` over the text gaps between tags only (never inside a tag's attributes)
function replaceInGaps(html, fn) {
  let out = "", last = 0, m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) { out += fn(html.slice(last, m.index)); out += m[0]; last = m.index + m[0].length; }
  return out + fn(html.slice(last));
}

export function resolveLinks(html, resolve) {
  const slots = [];
  // strip the reserved sentinel chars from author input first, so content can't
  // collide with the protect/restore tokens (grill: sentinel-collision).
  let h = String(html).replace(SENTINEL, "").replace(PROTECT, (m) => { slots.push(m); return "\uE000" + (slots.length - 1) + "\uE001"; });
  h = h.replace(A_WIKI, (_, dq, sq, uq, inner) => {
    const target = decodeEntities((dq != null ? dq : sq != null ? sq : uq != null ? uq : "").trim());
    const label = decodeEntities(stripTags(inner)) || target; // decode before resolve (no double-escape)
    return resolve(target, label);
  });
  // decode entities on the bare-link path too (the A_WIKI path above already does), so a
  // markdown-rendered `[[A&amp;B|A &amp; B]]` resolves to the real title "A&B" and its label
  // isn't double-escaped by the resolver.
  h = replaceInGaps(h, (gap) => gap.replace(WIKI_RE2_LINK, (_, t, l) => resolve(decodeEntities(t.trim()), decodeEntities((l || t).trim()))));
  return h.replace(/\uE000(\d+)\uE001/g, (_, i) => slots[+i]);
}

// \u2500\u2500 write-lane: rewrite a wiki reference Old \u2192 New across one doc's HTML \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Covers bare [[Old]] / [[Old|label]] in text, <a data-wiki="Old">, and typed
// data-<rel>="\u2026Old\u2026" relation lists. Protects <pre>/<code>. Returns { html, count }.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REL_SKIP = new Set(["title", "group", "icon", "updated", "type", "status", "words", "age", "wiki", "kind", "format", "height", "layout", "generated"]);

function rewriteRelValue(val, from, to) {
  if (val.includes("[[")) {
    // preserve an optional #anchor (and |label) just like the bare-link rewrite does
    const re = new RegExp("\\[\\[" + escapeRe(from) + "(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]", "g");
    return val.replace(re, (_, a, l) => "[[" + to + (a || "") + (l || "") + "]]");
  }
  return val.split(",").map((s) => (s.trim() === from ? to : s.trim())).join(", ");
}

export function rewriteWikiRef(html, from, to) {
  let count = 0;
  const slots = [];
  let h = String(html).replace(SENTINEL, "").replace(PROTECT, (m) => { slots.push(m); return "\uE000" + (slots.length - 1) + "\uE001"; });
  // preserve an optional #anchor (and optional |label) when renaming the doc target
  const bareRe = new RegExp("\\[\\[" + escapeRe(from) + "(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]", "g");
  h = replaceInGaps(h, (gap) => gap.replace(bareRe, (_m, a, l) => { count++; return "[[" + to + (a || "") + (l || "") + "]]"; }));
  // every data-* attribute (any element)
  h = h.replace(/\bdata-([\w-]+)\s*=\s*("|')([\s\S]*?)\2/gi, (m, key, q, val) => {
    const k = key.toLowerCase();
    // decode entities so data-wiki="A&amp;B" matches from "A&B"; preserve any #anchor
    if (k === "wiki") {
      const dec = decodeEntities(val.trim()), hash = dec.indexOf("#");
      const base = hash >= 0 ? dec.slice(0, hash) : dec, anc = hash >= 0 ? dec.slice(hash) : "";
      if (base === from) { count++; return 'data-wiki="' + escapeAttr(to + anc) + '"'; }
      return m;
    }
    if (REL_SKIP.has(k)) return m;
    // decode entities so a typed relation data-rel="[[A&amp;B]]" matches from "A&B" (same as
    // the data-wiki path); escapeAttr re-encodes on output.
    const dec = decodeEntities(val);
    if (!relTargets(dec).includes(from)) return m;
    count++;
    return "data-" + key + '="' + escapeAttr(rewriteRelValue(dec, from, to)) + '"';
  });
  return { html: h.replace(/\uE000(\d+)\uE001/g, (_, i) => slots[+i]), count };
}

// rewrite a doc's own title (frontmatter title:, data-title=, first <h1>) Old \u2192 New
export function rewriteTitle(html, from, to) {
  let changed = false;
  let h = String(html).replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_m, o, b, c) => {
    const nb = b.replace(/^(\s*title:\s*).*$/m, "$1" + to);
    if (nb !== b) changed = true;
    return o + nb + c;
  });
  h = h.replace(/(\bdata-title\s*=\s*)("|')([\s\S]*?)\2/i, (m, p, q, v) => { if (decodeEntities(v.trim()) === from) { changed = true; return p + '"' + escapeAttr(to) + '"'; } return m; }); // decode so data-title="A&amp;B" matches from "A&B"
  h = h.replace(/(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/i, (m, o, t, c) => { if (t.trim() === from) { changed = true; return o + escapeHtml(to) + c; } return m; });
  return { html: h, changed };
}

