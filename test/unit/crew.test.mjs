// L1 — substrate unit tests for the crew engine (scripts/crew.mjs). Driven exactly as the command
// drives it (subcommand argv, cwd = repo), asserting SIDE EFFECTS: the bureau/crew source, the
// materialized .claude/ artifacts, the BUREAU.md import block, drift detection, and clean removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREW = join(PLUGIN, "scripts", "crew.mjs");

function repo(t) { // a bureau repo: a workspace with a marker + a BUREAU.md for the crew block
  const r = mkdtempSync(join(tmpdir(), "bureau-crew-"));
  mkdirSync(join(r, "canon"), { recursive: true });
  writeFileSync(join(r, "canon", "bureau.json"), JSON.stringify({ workspace: "canon" }));
  writeFileSync(join(r, "BUREAU.md"), "# bureau\n\nrepo instructions.\n");
  if (t) t.after(() => rmSync(r, { recursive: true, force: true })); // don't leak the temp repo
  return r;
}
function crew(r, ...args) {
  try { return { stdout: execFileSync("node", [CREW, ...args], { cwd: r, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 20000 }), status: 0 }; }
  catch (e) { return { stdout: (e.stdout || "") + (e.stderr || ""), status: e.status == null ? 1 : e.status }; }
}

test("crew enable: copies a substituted source, materializes the agent, wires the brief import", (t) => {
  const r = repo(t);
  assert.equal(crew(r, "enable", "auditor").status, 0);
  // source landed under bureau/crew, workspace substituted, no tokens left
  const src = join(r, "bureau", "crew", "auditor", "agent.md");
  assert.ok(existsSync(src), "source agent.md exists");
  assert.match(readFileSync(join(r, "bureau", "crew", "auditor", "brief.md"), "utf8"), /canon\//);
  assert.ok(!/\{\{/.test(readFileSync(src, "utf8")), "no unsubstituted tokens in source");
  // materialized project agent: frontmatter at top + a bureau:gen marker, no tokens
  const mat = readFileSync(join(r, ".claude", "agents", "auditor.md"), "utf8");
  assert.match(mat, /^---\nname: auditor/, "frontmatter at line 1 (Claude can parse it)");
  assert.match(mat, /bureau:gen[^>]*sha256=/, "carries the generated marker + source hash");
  // brief rides BUREAU.md's @import rail
  assert.match(readFileSync(join(r, "BUREAU.md"), "utf8"), /<!-- bureau:crew -->[\s\S]*@bureau\/crew\/auditor\/brief\.md[\s\S]*<!-- \/bureau:crew -->/);
});

test("crew check: catches drift in the SOURCE *and* a hand-edit to the MATERIALIZED file", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  assert.equal(crew(r, "check").status, 0);
  // (a) the source drifts → check fails
  appendFileSync(join(r, "bureau", "crew", "auditor", "agent.md"), "\n<!-- edited -->\n");
  const a = crew(r, "check");
  assert.equal(a.status, 1, "stale source fails check");
  assert.match(a.stdout, /differs from source/);
  assert.equal(crew(r, "sync").status, 0);
  assert.equal(crew(r, "check").status, 0, "sync re-materialized → in sync again");
  // (b) someone hand-edits the MATERIALIZED file (marker untouched) — must still fail (no false green)
  appendFileSync(join(r, ".claude", "agents", "auditor.md"), "\n<!-- tampered -->\n");
  assert.equal(crew(r, "check").status, 1, "materialized-file tamper is caught (full-content compare)");
  assert.equal(crew(r, "sync").status, 0);
  assert.equal(crew(r, "check").status, 0, "sync heals it");
});

test("crew new: scaffolds a local member from the template and materializes it", (t) => {
  const r = repo(t);
  assert.equal(crew(r, "new", "scribe-helper", "--role", "drafts logbook minutes").status, 0);
  const src = readFileSync(join(r, "bureau", "crew", "scribe-helper", "agent.md"), "utf8");
  assert.match(src, /^---\nname: scribe-helper/, "{{NAME}} substituted");
  assert.ok(!/\{\{/.test(src), "no template tokens left");
  assert.ok(existsSync(join(r, ".claude", "agents", "scribe-helper.md")), "materialized as a project agent");
  assert.equal(crew(r, "check").status, 0);
});

test("crew disable: de-materializes but keeps the source; --purge removes the source", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  assert.equal(crew(r, "disable", "auditor").status, 0);
  assert.ok(!existsSync(join(r, ".claude", "agents", "auditor.md")), "materialized agent removed");
  assert.ok(existsSync(join(r, "bureau", "crew", "auditor", "agent.md")), "editable source kept");
  assert.ok(!/@bureau\/crew\/auditor/.test(readFileSync(join(r, "BUREAU.md"), "utf8")), "brief import removed");
  assert.equal(crew(r, "check").status, 0, "0 enabled members is clean");
  crew(r, "enable", "auditor");
  assert.equal(crew(r, "disable", "auditor", "--purge").status, 0);
  assert.ok(!existsSync(join(r, "bureau", "crew", "auditor")), "--purge removed the source too");
});

test("crew sync: a HYPHENATED member's skill materializes, survives re-sync, and removed skills are cleaned", (t) => {
  const r = repo(t);
  const m = join(r, "bureau", "crew", "scribe-helper"); // hyphenated — the old split('-') owner bug
  mkdirSync(join(m, "skills", "scan"), { recursive: true });
  writeFileSync(join(m, "crew.json"), JSON.stringify({ name: "scribe-helper", role: "t", enabled: true }));
  writeFileSync(join(m, "agent.md"), "---\nname: scribe-helper\ndescription: a probe\ntools: Read\n---\nbody\n");
  writeFileSync(join(m, "brief.md"), "## Crew · scribe-helper\nuse it.\n");
  writeFileSync(join(m, "skills", "scan", "SKILL.md"), "---\nname: scan\ndescription: scans\n---\nscan body\n");
  assert.equal(crew(r, "sync").status, 0);
  const skill = join(r, ".claude", "skills", "scribe-helper-scan", "SKILL.md");
  assert.ok(existsSync(skill), "skill materialized");
  assert.match(readFileSync(skill, "utf8"), /bureau:gen/, "skill carries the marker");
  assert.equal(crew(r, "sync").status, 0); // a SECOND sync must NOT misclassify owner and delete it
  assert.ok(existsSync(skill), "hyphenated member's skill survives re-sync (split('-') bug fixed)");
  assert.equal(crew(r, "check").status, 0);
  // remove the skill from source → sync must clean the materialized skill dir (not just on disable)
  rmSync(join(m, "skills"), { recursive: true, force: true });
  assert.equal(crew(r, "sync").status, 0);
  assert.ok(!existsSync(join(r, ".claude", "skills", "scribe-helper-scan")), "removed skill is cleaned up");
  assert.equal(crew(r, "check").status, 0);
});

test("crew: unsafe names refused at every entry point; a bad pre-existing dir fails check", (t) => {
  const r = repo(t);
  // Derive the traversal target from THIS repo's unique temp name, so a stray `escape` dir left in
  // tmpdir by another run (or a parallel test) can't make the "nothing written" check lie.
  const esc = basename(r) + "-escaped";
  assert.equal(crew(r, "new", "../" + esc).status, 1, "unsafe new rejected");
  // `../<esc>` from the repo root resolves to tmpdir()/<esc>; from the crew source dir it resolves to
  // r/bureau/<esc>. Nothing must land at either — the name is rejected before any path is joined.
  assert.ok(!existsSync(join(r, "..", esc)), "nothing written beside the repo");
  assert.ok(!existsSync(join(r, "bureau", esc)), "nothing written inside bureau/ via traversal");
  assert.equal(crew(r, "disable", "../x").status, 1, "unsafe disable rejected");
  // a pre-existing member dir with an unsafe name must be reported by check, never silently processed
  mkdirSync(join(r, "bureau", "crew", "BadName"), { recursive: true });
  writeFileSync(join(r, "bureau", "crew", "BadName", "crew.json"), JSON.stringify({ name: "BadName" }));
  const c = crew(r, "check");
  assert.equal(c.status, 1, "unsafe pre-existing member dir fails check");
  assert.match(c.stdout, /unsafe member dir/);
});
