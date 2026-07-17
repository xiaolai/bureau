#!/usr/bin/env node
// Build the self-contained gazette bundle from bureau's OWN renderer source (press/src).
// Output: press/bin/gazette.mjs — markdown-it / node-html-parser / sanitize-html inlined,
// no node_modules at runtime (Node ≥18). bin/gazette.mjs is what bureau:inspect runs.
// Rebuild after editing press/src:
//   cd press && npm install   (once — esbuild is a devDependency, so NOT --omit=dev)
//   node ../scripts/build-gazette.mjs
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
const gz = resolve(dirname(fileURLToPath(import.meta.url)), "..", "press");
if (!existsSync(join(gz, "node_modules"))) {
  console.error("✗ press/node_modules missing — run `cd press && npm install` first (esbuild is a devDependency).");
  process.exit(1);
}
// Invoke the PINNED, project-local esbuild — never `npx --yes esbuild`, which can fetch and
// execute an unpinned latest from the network. The binary is guaranteed present by the check above.
const esbuild = join(gz, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
if (!existsSync(esbuild)) {
  console.error("✗ esbuild not in press/node_modules — run `cd press && npm install` first (esbuild is a devDependency).");
  process.exit(1);
}
execFileSync(esbuild, [
  join(gz, "bin", "cli.mjs"),
  "--bundle", "--platform=node", "--format=esm",
  "--outfile=" + join(gz, "bin", "gazette.mjs"),
  "--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
], { stdio: ["ignore", "inherit", "inherit"], cwd: gz });
console.log("✓ built press/bin/gazette.mjs");
