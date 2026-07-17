import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { escapeHtml, escapeAttr } from "../src/shared/escape.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DOCS = resolve(here, "..", "examples", "golden", "gazette");
export const FIXED_NOW = "2026-06-09"; // deterministic staleness baseline for tests

const DATA_KEY = /^[A-Za-z][A-Za-z0-9-]*$/; // a data-* suffix must be a valid attribute name

// Build an HTML-fragment doc for fixtures. `meta` keys → data-* on the root <article>
// (title becomes the <h1>); ONLY `body` is raw inner HTML. Attribute values are fully escaped
// (was: only `"`), the title is escaped (was: injected raw — so a title with markup/entities
// silently became structure), and a malformed data-* key throws instead of emitting a broken tag.
export function doc(meta = {}, body = "") {
  const attrs = Object.entries(meta)
    .filter(([k, v]) => k !== "title" && v != null)
    .map(([k, v]) => {
      if (!DATA_KEY.test(k)) throw new Error('doc(): invalid data-* key "' + k + '"');
      return "data-" + k + '="' + escapeAttr(String(v)) + '"';
    })
    .join(" ");
  const h1 = meta.title != null ? "<h1>" + escapeHtml(String(meta.title)) + "</h1>" : "";
  return "<article" + (attrs ? " " + attrs : "") + ">" + h1 + body + "</article>";
}
