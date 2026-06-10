// build-runtime — concatenate the runtime ESM modules into the single offline
// browser bundle template/lib/app.js. The artifact must load as a plain <script>
// from file:// (no ESM imports at runtime), so we author as modules (testable in
// Node) and bundle at build time (PRD P4 — compute at build, ship static).
//
// Naive concatenation: strip `import …`/`export ` (resolved by concat order +
// shared IIFE scope) and wrap in one IIFE. Safe for this small, controlled set —
// modules use only named import/export and have no name collisions.
import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
// concat order = dependency order (escape ← slug ← pure ← viz ← dom)
const SOURCES = ["src/shared/escape.mjs", "src/shared/slug.mjs", "src/runtime/pure.mjs", "src/runtime/viz.mjs", "src/runtime/dom.mjs"];
const OUT = resolve(ROOT, "template/lib/app.js");

function strip(code) {
  return code
    // drop import statements (named or default; possibly multi-line)
    .replace(/import\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["'];?/g, "")
    // `export function f` → `function f`, `export const c` → `const c`, …
    .replace(/^export\s+(function|const|let|var|class)\b/gm, "$1")
    // drop bare `export { … };` re-export lines (none expected in bundled files)
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, "")
    .replace(/^\s*\n(\s*\n)+/gm, "\n") // collapse blank runs left by stripped imports
    .trim();
}

export function bundleRuntime() {
  const parts = SOURCES.map((p) => strip(readFileSync(resolve(ROOT, p), "utf8")));
  const header =
    "// ⚠ auto-generated. Do not edit. Source: src/runtime/*.mjs + src/shared/escape.mjs.\n" +
    "// rebuild with: npm run build:runtime (CI verifies this file is current).\n";
  return header + '(function () {\n"use strict";\n\n' + parts.join("\n\n") + "\n})();\n";
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  writeFileSync(OUT, bundleRuntime());
  console.log("✓ built " + OUT);
}
