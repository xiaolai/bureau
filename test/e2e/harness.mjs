#!/usr/bin/env node
// L3 live behavioral harness. For each scenario: a throwaway git repo with bureau installed
// project-scoped, each step driven by a real `claude -p` call, then rule + LLM judges applied to
// the resulting WORKSPACE STATE and transcript. Exit 0 iff every judge passes.
//
// This is the ENVIRONMENT-COUPLED layer. Prereqs: the `claude` CLI authenticated, and the
// plugin installable. By DEFAULT it installs the LOCAL checkout (this repo) so the run tests the
// code under review; set BUREAU_PLUGIN_REF (e.g. `bureau@xiaolai`) to test a published release
// instead. It costs tokens by design — that is what behavioral E2E is. The deterministic
// layers (run via `node test/run.mjs`) carry most of the load; this proves the few flows where
// only an actual LLM run can.
//
// ISOLATION CAVEAT: each step runs `claude -p --permission-mode bypassPermissions`, which grants
// the run unrestricted tool access (the point is to drive flows unattended). This is NOT OS-level
// sandboxed — run it only in a disposable/CI environment you trust, never against untrusted
// scenarios on a host with secrets. Temp repos are removed after each scenario unless
// BUREAU_KEEP_REPOS is set (keep them to debug a failure).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { scenarios } from "./scenarios.mjs";
import { claudeAvailable, llmJudge } from "./judges/llm.mjs";

// Default to the LOCAL checkout so the live layer exercises the code UNDER REVIEW, not a published
// build. `claude plugin install <local-dir>` installs from the path; override with BUREAU_PLUGIN_REF
// (e.g. `bureau@xiaolai`) to deliberately test a marketplace release instead.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_REF = process.env.BUREAU_PLUGIN_REF || PLUGIN_ROOT;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function runClaude(repo, prompt) {
  // `--permission-mode bypassPermissions` is INTENTIONAL and gated: this is the opt-in `--e2e` layer
  // the operator runs deliberately with auth + tokens, in a disposable/CI environment, to drive flows
  // unattended (see the ISOLATION CAVEAT header). It is NOT sandboxed — never run against untrusted
  // scenarios on a host with secrets. Do not "fix" this to a narrower mode; it would stall the run.
  const raw = sh("claude", ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json", prompt], { cwd: repo, timeout: 600000 });
  try { const o = JSON.parse(raw); return o.result ?? o.text ?? raw; } catch { return raw; }
}

function main() {
  if (!claudeAvailable()) {
    console.error("✗ e2e: `claude` CLI not found or not authenticated — skipping the live layer.\n  Run the deterministic layers with `node test/run.mjs` (no API needed).");
    process.exit(2);
  }
  let failed = 0;
  for (const sc of scenarios) {
    const repo = mkdtempSync(join(tmpdir(), "bureau-live-"));
    try {
      sh("git", ["init", "-q"], { cwd: repo });
      writeFileSync(join(repo, ".gitignore"), "/board/\n");
      try { sh("claude", ["plugin", "install", PLUGIN_REF, "--scope", "project"], { cwd: repo, timeout: 300000 }); }
      catch (e) { console.error(`✗ install ${PLUGIN_REF} failed in test repo: ${(e.message || e).slice(0, 200)}`); failed++; continue; }

      console.log("\n▶ " + sc.name + "  (" + repo + ")");
      for (const step of sc.steps) {
        let transcript = "";
        try { transcript = runClaude(repo, step.prompt); }
        catch (e) {
          // A crashed step leaves the workspace in a broken/partial state; every later step in THIS
          // scenario builds on it, so their verdicts would be meaningless. Abort the scenario (the
          // outer loop moves on to the next one), rather than marching on against broken state.
          console.log(`    ✗ step crashed — aborting scenario: ${step.prompt.slice(0, 50)} — ${(e.message || e).slice(0, 120)}`);
          failed++; break;
        }
        // Guard each judge: a THROWN judge (a bug in the judge itself) must record a failed verdict,
        // never abort the whole harness and lose every other scenario's result.
        const verdicts = [];
        if (step.rule) {
          try { verdicts.push(...step.rule(repo)); }
          catch (e) { verdicts.push({ name: "rule-judge", pass: false, detail: "rule judge threw: " + (e.message || e) }); }
        }
        if (step.llm) {
          try { verdicts.push(llmJudge({ rubric: step.llm.rubric, transcript })); }
          catch (e) { verdicts.push({ name: "llm-judge", pass: false, detail: "llm judge threw: " + (e.message || e) }); }
        }
        for (const v of verdicts) {
          console.log(`    ${v.pass ? "✓" : "✗"} ${v.name}: ${v.detail}`);
          if (!v.pass) failed++;
        }
      }
    } finally {
      // clean up the throwaway repo (transcripts + workspace state) unless asked to keep it.
      if (!process.env.BUREAU_KEEP_REPOS) try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  console.log(failed ? `\n✗ e2e: ${failed} judge failure(s)` : "\n✓ e2e: all scenarios passed");
  process.exit(failed ? 1 : 0);
}
main();
