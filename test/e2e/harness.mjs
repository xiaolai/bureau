#!/usr/bin/env node
// L3 live behavioral harness. For each scenario: a throwaway git repo with bureau installed
// project-scoped, each step driven by a real `claude -p` call, then rule + LLM judges applied to
// the resulting WORKSPACE STATE and transcript. Exit 0 iff every judge passes.
//
// This is the ENVIRONMENT-COUPLED layer. Prereqs: the `claude` CLI authenticated, and the
// plugin installable (default `bureau@xiaolai`; set BUREAU_PLUGIN_REF for a local/dev install
// reference). It costs tokens by design — that is what behavioral E2E is. The deterministic
// layers (run via `node test/run.mjs`) carry most of the load; this proves the few flows where
// only an actual LLM run can.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { scenarios } from "./scenarios.mjs";
import { claudeAvailable, llmJudge } from "./judges/llm.mjs";

const PLUGIN_REF = process.env.BUREAU_PLUGIN_REF || "bureau@xiaolai";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function runClaude(repo, prompt) {
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
    sh("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "/board/\n");
    try { sh("claude", ["plugin", "install", PLUGIN_REF, "--scope", "project"], { cwd: repo }); }
    catch (e) { console.error(`✗ install ${PLUGIN_REF} failed in test repo: ${(e.message || e).slice(0, 200)}`); failed++; continue; }

    console.log("\n▶ " + sc.name + "  (" + repo + ")");
    for (const step of sc.steps) {
      let transcript = "";
      try { transcript = runClaude(repo, step.prompt); }
      catch (e) { console.log(`    ✗ step crashed: ${step.prompt.slice(0, 50)} — ${(e.message || e).slice(0, 120)}`); failed++; continue; }
      const verdicts = [...(step.rule ? step.rule(repo) : [])];
      if (step.llm) verdicts.push(llmJudge({ rubric: step.llm.rubric, transcript }));
      for (const v of verdicts) {
        console.log(`    ${v.pass ? "✓" : "✗"} ${v.name}: ${v.detail}`);
        if (!v.pass) failed++;
      }
    }
  }
  console.log(failed ? `\n✗ e2e: ${failed} judge failure(s)` : "\n✓ e2e: all scenarios passed");
  process.exit(failed ? 1 : 0);
}
main();
