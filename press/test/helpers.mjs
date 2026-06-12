import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DOCS = resolve(here, "..", "examples", "golden", "gazette");
export const FIXED_NOW = "2026-06-09"; // deterministic staleness baseline for tests

// Build an HTML-fragment doc for fixtures. `meta` keys → data-* on the root <article>
// (title becomes the <h1>); `body` is raw inner HTML. Mirrors the docs/*.html model.
export function doc(meta = {}, body = "") {
  const attrs = Object.entries(meta)
    .filter(([k, v]) => k !== "title" && v != null)
    .map(([k, v]) => 'data-' + k + '="' + String(v).replace(/"/g, "&quot;") + '"')
    .join(" ");
  const h1 = meta.title != null ? "<h1>" + meta.title + "</h1>" : "";
  return "<article" + (attrs ? " " + attrs : "") + ">" + h1 + body + "</article>";
}
