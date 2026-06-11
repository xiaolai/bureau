#!/usr/bin/env node
// Build the self-contained gazette bundle from bureau's OWN renderer source (gazette/src).
// Output: gazette/bin/gazette.mjs — markdown-it / node-html-parser / sanitize-html inlined,
// no node_modules at runtime (Node ≥18). bin/gazette.mjs is what bureau:inspect runs.
// Rebuild after editing gazette/src:
//   cd gazette && npm install --omit=dev   (once — fetch the bundler's inputs)
//   node ../scripts/build-gazette.mjs
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
const gz = resolve(dirname(fileURLToPath(import.meta.url)), "..", "gazette");
if (!existsSync(join(gz, "node_modules"))) {
  console.error("✗ gazette/node_modules missing — run `cd gazette && npm install --omit=dev` first.");
  process.exit(1);
}
// Invoke the PINNED, project-local esbuild — never `npx --yes esbuild`, which can fetch and
// execute an unpinned latest from the network. The binary is guaranteed present by the check above.
const esbuild = join(gz, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
if (!existsSync(esbuild)) {
  console.error("✗ esbuild not in gazette/node_modules — run `cd gazette && npm install --omit=dev` first.");
  process.exit(1);
}
execFileSync(esbuild, [
  join(gz, "bin", "cli.mjs"),
  "--bundle", "--platform=node", "--format=esm",
  "--outfile=" + join(gz, "bin", "gazette.mjs"),
  "--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
], { stdio: ["ignore", "inherit", "inherit"], cwd: gz });
console.log("✓ built gazette/bin/gazette.mjs");
