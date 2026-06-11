#!/usr/bin/env node
// bureau test orchestrator. Runs the DETERMINISTIC pyramid by default (no API, always green):
//   L0 static structure · L1 hook-script units · L1 gazette renderer · L3 judge self-test.
// Pass --e2e to ALSO run the live behavioral layer (`claude -p`, needs auth + tokens).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
let failed = 0;
const step = (label, fn) => { console.log(`\n=== ${label} ===`); try { fn(); } catch { failed++; console.error(`✗ ${label} FAILED`); } };

step("L0 · static structure", () => run("node", ["test/static/check.mjs"]));
step("L1 · hook-script units", () => run("node", ["--test", "test/unit/scripts.test.mjs"]));
step("L1 · gazette renderer", () => {
  if (!existsSync(join(ROOT, "gazette", "node_modules")))
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: join(ROOT, "gazette") });
  run("node", ["--test"], { cwd: join(ROOT, "gazette") });
});
step("L3 · judge self-test (deterministic)", () => run("node", ["--test", "test/e2e/judges.test.mjs"]));
step("L1 · self-canon fixture (dogfood)", () => run("node", ["--test", "test/canon.test.mjs"]));

if (process.argv.includes("--e2e"))
  step("L3 · live behavioral (claude -p)", () => run("node", ["test/e2e/harness.mjs"]));

console.log(failed ? `\n✗ ${failed} layer(s) failed` : "\n✓ all layers green");
process.exit(failed ? 1 : 0);
