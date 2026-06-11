// Deterministic self-test of the L3 rule judges (NO LLM). It builds known-good and known-bad
// workspace fixtures and proves each judge passes the good one and fails the bad one — so when
// the live harness runs the judges against a real `claude -p` flow, a green/red verdict means
// what it says. This is the bridge between "untestable LLM behavior" and a trustworthy gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { logbookEntryExists, noLeftoverTokens, recallRuleInstalled, compileProducedProposed, reviewPromotedToCanonical, boardBuildsHealthy } from "./judges/rule.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const today = () => new Date().toISOString().slice(0, 10);

// scaffold a workspace the way `bureau:init` would (copy template, substitute, install rule).
function scaffold() {
  const repo = mkdtempSync(join(tmpdir(), "bureau-e2e-"));
  cpSync(join(PLUGIN, "templates", "workspace"), join(repo, "bureau"), { recursive: true });
  const sub = (p, k, v) => writeFileSync(p, readFileSync(p, "utf8").replaceAll(k, v));
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(md|json)$/.test(e.name)) sub(p, "{{DATE}}", today()); } };
  walk(join(repo, "bureau"));
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "bureau.md"), readFileSync(join(PLUGIN, "templates", "recall-rule.md"), "utf8").replaceAll("{{WORKSPACE}}", "bureau"));
  return repo;
}
const ws = (repo) => join(repo, "bureau");
const captureSession = (repo, id) => execFileSync("node", [join(PLUGIN, "scripts", "capture-stub.mjs")], { cwd: repo, input: JSON.stringify({ session_id: id }), stdio: ["pipe", "ignore", "ignore"] });
const writePage = (repo, name, status) => writeFileSync(join(ws(repo), "decisions", name), `---\ntitle: ${name.replace(/\.md$/, "")}\nupdated: ${today()}\nstatus: ${status}\n---\n# ${name}\nA claim. **Sources.** [[Logbook]]\n`);

test("judge logbookEntryExists: passes with an entry, fails without", () => {
  const good = scaffold(); captureSession(good, "feed1234");
  assert.equal(logbookEntryExists(ws(good)).pass, true);
  assert.equal(logbookEntryExists(ws(scaffold())).pass, false); // fresh scaffold, no session captured
});

test("judge noLeftoverTokens: passes clean, fails on an unsubstituted token", () => {
  const good = scaffold();
  assert.equal(noLeftoverTokens(good).pass, true);
  const bad = scaffold(); writeFileSync(join(ws(bad), "decisions", "x.md"), "leftover {{DATE}} here");
  assert.equal(noLeftoverTokens(bad).pass, false);
});

test("judge recallRuleInstalled: passes when installed+substituted, fails when absent", () => {
  assert.equal(recallRuleInstalled(scaffold()).pass, true);
  assert.equal(recallRuleInstalled(mkdtempSync(join(tmpdir(), "bureau-e2e-"))).pass, false);
});

test("judge compileProducedProposed: passes proposed page, FAILS if compile leaked canonical", () => {
  const good = scaffold(); writePage(good, "ttl.md", "proposed");
  assert.equal(compileProducedProposed(ws(good), "ttl").pass, true);
  const bad = scaffold(); writePage(bad, "ttl.md", "canonical"); // the bug we must catch
  assert.equal(compileProducedProposed(ws(bad), "ttl").pass, false);
});

test("judge reviewPromotedToCanonical: fails at proposed, passes once approved", () => {
  const repo = scaffold(); writePage(repo, "ttl.md", "proposed");
  assert.equal(reviewPromotedToCanonical(ws(repo), "ttl").pass, false);
  writePage(repo, "ttl.md", "canonical");
  assert.equal(reviewPromotedToCanonical(ws(repo), "ttl").pass, true);
});

test("judge boardBuildsHealthy: passes a clean scaffold, fails on a dangling link", () => {
  const good = scaffold(); captureSession(good, "feed1234"); writeFileSync(join(good, ".gitignore"), "/board/\n");
  assert.equal(boardBuildsHealthy(good, "bureau").pass, true);
  const bad = scaffold(); writePage(bad, "dangle.md", "proposed");
  writeFileSync(join(ws(bad), "decisions", "dangle.md"), `---\ntitle: Dangle\nstatus: proposed\n---\n# Dangle\nSee [[Nonexistent Page]].\n`);
  assert.equal(boardBuildsHealthy(bad, "bureau").pass, false); // the [[Nonexistent Page]] dangles
});
