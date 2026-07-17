#!/usr/bin/env node
// bureau test orchestrator. Runs the DETERMINISTIC pyramid by default (no API, always green):
//   L0 static structure · L1 hook-script units · L1 press renderer · L3 judge self-test.
// Pass --e2e to ALSO run the live behavioral layer (`claude -p`, needs auth + tokens).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// A per-layer timeout backstop: a hung test layer fails the layer instead of stalling CI forever.
const LAYER_TIMEOUT_MS = Number(process.env.BUREAU_LAYER_TIMEOUT_MS) || 600000;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", timeout: LAYER_TIMEOUT_MS, ...opts });
let failed = 0;
const step = (label, fn) => { console.log(`\n=== ${label} ===`); try { fn(); } catch { failed++; console.error(`✗ ${label} FAILED`); } };

step("L0 · static structure", () => run("node", ["test/static/check.mjs"]));
step("L1 · hook-script units", () => run("node", ["--test", "test/unit/scripts.test.mjs"]));
step("L1 · crew engine units", () => run("node", ["--test", "test/unit/crew.test.mjs"]));
step("L1 · chamber server units", () => run("node", ["--test", "test/unit/serve.test.mjs"]));
step("L1 · press renderer", () => {
  const pressDir = join(ROOT, "press");
  if (!existsSync(join(pressDir, "node_modules"))) {
    // The press unit tests need their dev deps, but a test run must NOT silently hit the network
    // and mutate dependency state every time. Install them once as an explicit setup step. Opt in
    // to an automatic install with BUREAU_ALLOW_NPM_INSTALL=1 (prefers `npm ci` — clean, pinned to
    // the lockfile — falling back to `npm install` when no lockfile is present).
    if (process.env.BUREAU_ALLOW_NPM_INSTALL === "1") {
      const ciable = existsSync(join(pressDir, "package-lock.json"));
      run("npm", [ciable ? "ci" : "install", "--no-audit", "--no-fund"], { cwd: pressDir });
    } else {
      console.error(
        "  press/node_modules is missing — the press unit tests need their dev deps.\n" +
        "  Run `npm ci` (or `npm install`) in press/ once, or set BUREAU_ALLOW_NPM_INSTALL=1 to\n" +
        "  auto-install. Refusing to hit the network mid-suite.");
      throw new Error("press dev deps not installed");
    }
  }
  run("node", ["--test"], { cwd: pressDir });
});
step("L3 · judge self-test (deterministic)", () => run("node", ["--test", "test/e2e/judges.test.mjs"]));
step("L1 · self-canon fixture (dogfood)", () => run("node", ["--test", "test/canon.test.mjs"]));

if (process.argv.includes("--e2e"))
  step("L3 · live behavioral (claude -p)", () => run("node", ["test/e2e/harness.mjs"]));

console.log(failed ? `\n✗ ${failed} layer(s) failed` : "\n✓ all layers green");
process.exit(failed ? 1 : 0);
