#!/usr/bin/env node
// Vendor the **gazette** dashboard (bureau's bundled renderer) from the upstream renderer
// source (the xiaolai/whiteboard repo). Produces a SELF-CONTAINED dashboard so bureau ships
// one installable plugin with no separate install and no node_modules:
//
//   gazette/bin/gazette.mjs    — esbuild bundle: markdown-it / node-html-parser / sanitize-html
//                                inlined (createRequire banner so postcss's dynamic require
//                                resolves); node builtins stay external. Runs on Node ≥18 alone.
//   gazette/template/  themes/ — the renderer's data assets (pre-built browser bundle + themes).
//
// Re-run this whenever the upstream renderer changes. Maintainer tool: needs the source
// checkout and npx/esbuild (fetched on first run). Default source: the sibling ../whiteboard.
//
//   node scripts/vendor-gazette.mjs [path-to-renderer-source]
import { execFileSync } from "child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const bureauRoot = resolve(here, "..");
const src = process.argv[2] ? resolve(process.argv[2]) : resolve(bureauRoot, "..", "whiteboard");

if (!existsSync(join(src, "bin", "cli.mjs"))) {
  console.error("✗ renderer source not found at " + src + "\n  pass the path as an argument: node scripts/vendor-gazette.mjs <renderer-src>");
  process.exit(1);
}

const out = join(bureauRoot, "gazette");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });

// 1. bundle the renderer CLI into one self-contained ESM file.
console.log("• bundling renderer → gazette/bin/gazette.mjs");
execFileSync("npx", [
  "--yes", "esbuild", join(src, "bin", "cli.mjs"),
  "--bundle", "--platform=node", "--format=esm",
  "--outfile=" + join(out, "bin", "gazette.mjs"),
  // esbuild's __require shim falls back to this real require for postcss's dynamic require()
  "--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
], { stdio: ["ignore", "inherit", "inherit"] });

// 2. copy the data assets the bundle reads at runtime (template) + the theme library.
console.log("• copying template/ + themes/");
cpSync(join(src, "template"), join(out, "template"), { recursive: true });
cpSync(join(src, "themes"), join(out, "themes"), { recursive: true });

console.log("✓ vendored gazette → " + out + "  (self-contained; no node_modules needed)");
