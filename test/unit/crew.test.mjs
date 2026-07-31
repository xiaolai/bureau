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
import { createHash } from "node:crypto";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREW = join(PLUGIN, "scripts", "crew.mjs");
const sha256 = (s) => createHash("sha256").update(s).digest("hex"); // same shape crew.mjs uses for base shas

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

test("crew: agent frontmatter name must match the member dir — sync REFUSES it, check reports it", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  assert.equal(crew(r, "check").status, 0);
  // Break the SOURCE agent's frontmatter name. Transactional sync validates the plan first, so it
  // must ABORT (not materialize a subagent that would register under the wrong name).
  const src = join(r, "bureau", "crew", "auditor", "agent.md");
  writeFileSync(src, readFileSync(src, "utf8").replace(/^name: auditor$/m, "name: reviewer"));
  const s = crew(r, "sync");
  assert.equal(s.status, 1, "sync aborts on a name≠dir plan");
  assert.match(s.stdout, /frontmatter name "reviewer" != member dir "auditor"/);
  assert.match(s.stdout, /nothing written/);
  const c = crew(r, "check");
  assert.equal(c.status, 1, "check reports the same");
  assert.match(c.stdout, /frontmatter name "reviewer" != member dir "auditor"/);
});

test("crew check: rejects a mismatched-quote name and a YAML-null description (parser hardening)", (t) => {
  const r = repo(t);
  const m = join(r, "bureau", "crew", "probe");
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "crew.json"), JSON.stringify({ name: "probe", role: "t", enabled: true }));
  writeFileSync(join(m, "brief.md"), "## Crew · probe\nuse it.\n");
  writeFileSync(join(m, "agent.md"), "---\nname: \"probe'\ndescription: ok\n---\nbody\n"); // mismatched quotes
  assert.match(crew(r, "check").stdout, /no valid name/);
  writeFileSync(join(m, "agent.md"), "---\nname: probe\ndescription: ~\n---\nbody\n");     // YAML-null description
  assert.match(crew(r, "check").stdout, /has no description/);
  writeFileSync(join(m, "agent.md"), "---\nname: probe\ndescription: null # nothing\n---\nbody\n"); // null + inline comment
  assert.match(crew(r, "check").stdout, /has no description/);
  // a BLOCK-scalar description with real (even absurd) content is NOT null — must be accepted
  writeFileSync(join(m, "agent.md"), "---\nname: probe\ndescription: |\n  null # literal content\n---\nbody\n");
  assert.doesNotMatch(crew(r, "check").stdout, /has no description/);
});

test("crew sync: an invalid member aborts the WHOLE sync — a valid sibling is not partially materialized", (t) => {
  const r = repo(t);
  const good = join(r, "bureau", "crew", "good");           // one valid member…
  mkdirSync(good, { recursive: true });
  writeFileSync(join(good, "crew.json"), JSON.stringify({ name: "good", role: "t", enabled: true }));
  writeFileSync(join(good, "agent.md"), "---\nname: good\ndescription: ok\ntools: Read\n---\nbody\n");
  writeFileSync(join(good, "brief.md"), "## Crew · good\nuse it.\n");
  const bad = join(r, "bureau", "crew", "bad");             // …and one INVALID member (name ≠ dir)
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "crew.json"), JSON.stringify({ name: "bad", role: "t", enabled: true }));
  writeFileSync(join(bad, "agent.md"), "---\nname: wrong\ndescription: ok\ntools: Read\n---\nbody\n");
  writeFileSync(join(bad, "brief.md"), "## Crew · bad\nuse it.\n");
  const s = crew(r, "sync");
  assert.equal(s.status, 1, "sync aborts on the invalid member");
  assert.match(s.stdout, /nothing written/);
  assert.ok(!existsSync(join(r, ".claude", "agents", "good.md")), "the VALID sibling was NOT materialized (all-or-nothing)");
  assert.ok(!existsSync(join(r, ".claude", "agents", "bad.md")), "the invalid member was not materialized");
});

test("crew new/enable: with no BUREAU.md, abort BEFORE any write (no orphaned materialized agent)", (t) => {
  // The reproduced partial-state bug: installTemplate + materialize ran, then rewriteCrewBlock died on
  // the missing BUREAU.md, leaving an orphan .claude/agents/<name>.md. requireBureauMd now preflights.
  const r = mkdtempSync(join(tmpdir(), "bureau-crew-noinit-"));
  t.after(() => rmSync(r, { recursive: true, force: true }));
  mkdirSync(join(r, "canon"), { recursive: true });
  writeFileSync(join(r, "canon", "bureau.json"), JSON.stringify({ workspace: "canon" })); // NOTE: no BUREAU.md
  const n = crew(r, "new", "probe", "--role", "x");
  assert.equal(n.status, 1, "aborts without BUREAU.md");
  assert.match(n.stdout, /no BUREAU\.md/);
  assert.ok(!existsSync(join(r, "bureau", "crew", "probe")), "no source scaffolded");
  assert.ok(!existsSync(join(r, ".claude", "agents", "probe.md")), "no orphan agent materialized");
});

test("crew new: --workspace must carry a real value and name a real workspace", (t) => {
  const r = repo(t); // has canon/
  const bare = crew(r, "new", "probe", "--role", "x", "--workspace"); // bare flag → error, not silent auto-detect
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /--workspace needs a value/);
  assert.ok(!existsSync(join(r, "bureau", "crew", "probe")), "nothing scaffolded on the bare-flag error");
  const typo = crew(r, "new", "probe", "--role", "x", "--workspace", "cannon"); // typo → rejected, not substituted
  assert.equal(typo.status, 1);
  assert.match(typo.stdout, /not a workspace/);
});

test("crew new: an ambiguous workspace fails loud and scaffolds nothing; --workspace disambiguates", (t) => {
  const r = repo(t); // already has canon/
  mkdirSync(join(r, "notes"), { recursive: true });
  writeFileSync(join(r, "notes", "bureau.json"), JSON.stringify({ workspace: "notes" }));
  // two marker-carrying workspaces ⇒ detection is ambiguous ⇒ must NOT silently pick `canon`
  const amb = crew(r, "new", "helper", "--role", "x");
  assert.equal(amb.status, 1, "ambiguous workspace is a hard error");
  assert.match(amb.stdout, /ambiguous workspace/);
  assert.ok(!existsSync(join(r, "bureau", "crew", "helper")), "nothing scaffolded on the ambiguous error");
  // --workspace picks one → succeeds and substitutes it into the agent's grounding prompt
  assert.equal(crew(r, "new", "helper", "--role", "x", "--workspace", "notes").status, 0);
  assert.match(readFileSync(join(r, "bureau", "crew", "helper", "agent.md"), "utf8"), /notes\//);
  assert.equal(crew(r, "check").status, 0);
});

test("crew sync: a skill-dir slug collision across members fails loud (kebab join is not injective)", (t) => {
  const r = repo(t);
  // member `a` + skill `b-c`  and  member `a-b` + skill `c`  both map to .claude/skills/a-b-c/
  for (const [mem, skill] of [["a", "b-c"], ["a-b", "c"]]) {
    const m = join(r, "bureau", "crew", mem);
    mkdirSync(join(m, "skills", skill), { recursive: true });
    writeFileSync(join(m, "crew.json"), JSON.stringify({ name: mem, role: "t", enabled: true }));
    writeFileSync(join(m, "agent.md"), `---\nname: ${mem}\ndescription: probe\ntools: Read\n---\nbody\n`);
    writeFileSync(join(m, "brief.md"), `## Crew · ${mem}\nuse it.\n`);
    writeFileSync(join(m, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: s\n---\nbody\n`);
  }
  const c = crew(r, "sync");
  assert.equal(c.status, 1, "collision is a hard error, not a confusing overwrite refusal");
  assert.match(c.stdout, /collision/);
  assert.equal(crew(r, "check").status, 1, "check reports the same collision");
});

test("crew: contained layout — a workspace NAMED `bureau` (marker-based) resolves for {{WORKSPACE}}", (t) => {
  // No canon/: the repo's single marker-carrying dir IS `bureau/` (the contained layout, where the
  // crew source nests inside the workspace at bureau/crew/). detectWorkspace must resolve it by its
  // bureau.json marker — not exclude it by name and silently fall back to the `canon` default.
  const r = mkdtempSync(join(tmpdir(), "bureau-crew-contained-"));
  t.after(() => rmSync(r, { recursive: true, force: true }));
  mkdirSync(join(r, "bureau"), { recursive: true });
  writeFileSync(join(r, "bureau", "bureau.json"), JSON.stringify({ workspace: "bureau", board: "gazette" }));
  writeFileSync(join(r, "BUREAU.md"), "# bureau\n\nrepo instructions.\n");
  assert.equal(crew(r, "enable", "auditor").status, 0);
  const brief = readFileSync(join(r, "bureau", "crew", "auditor", "brief.md"), "utf8");
  assert.match(brief, /`bureau\/`/, "{{WORKSPACE}} substituted with the contained workspace name");
  assert.ok(!/canon\//.test(brief), "did not fall back to the `canon` default");
  assert.equal(crew(r, "check").status, 0, "contained-layout crew is in sync");
});

// ── crew update (file-level 3-way against the recorded base) ──────────────────────
const auditorCj = (r) => join(r, "bureau", "crew", "auditor", "crew.json");
const auditorAgent = (r) => join(r, "bureau", "crew", "auditor", "agent.md");
const setBaseSha = (r, rel, shaHex) => { const cj = JSON.parse(readFileSync(auditorCj(r), "utf8")); cj.upstream.base[rel] = shaHex; writeFileSync(auditorCj(r), JSON.stringify(cj, null, 2) + "\n"); };

test("crew enable: records upstream tracking (frozen bindings + per-file base shas)", (t) => {
  const r = repo(t);
  assert.equal(crew(r, "enable", "auditor").status, 0);
  const cj = JSON.parse(readFileSync(auditorCj(r), "utf8"));
  assert.ok(cj.upstream, "upstream recorded");
  assert.equal(cj.upstream.template, "auditor");
  assert.equal(cj.upstream.bindings.NAME, "auditor");
  assert.equal(cj.upstream.bindings.WORKSPACE, "canon");
  assert.ok(/^[0-9a-f]{64}$/.test(cj.upstream.base["agent.md"]), "agent.md base is a sha256");
  const u = crew(r, "update", "auditor", "--check");   // a fresh enable is up-to-date against its own base
  assert.equal(u.status, 0);
  assert.match(u.stdout, /up-to-date/);
});

test("crew update: an upstream-only change is applied (local untouched)", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  // Simulate "upstream moved on": set local == base to an OLD version, so the current shipped template
  // (U) differs from base while the user hasn't edited → take upstream.
  const old = readFileSync(auditorAgent(r), "utf8") + "\n<!-- old upstream line -->\n";
  writeFileSync(auditorAgent(r), old);
  setBaseSha(r, "agent.md", sha256(old));
  const u = crew(r, "update", "auditor");
  assert.equal(u.status, 0, "clean update applies");
  assert.match(u.stdout, /updated/);
  assert.ok(!readFileSync(auditorAgent(r), "utf8").includes("<!-- old upstream line -->"), "local advanced to current upstream");
  assert.equal(crew(r, "check").status, 0, "re-materialized and in sync");
});

test("crew update: a both-sides change is a CONFLICT — nothing written", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  setBaseSha(r, "agent.md", sha256("A BASE DISTINCT FROM BOTH SIDES"));   // base != local, != upstream
  const edited = readFileSync(auditorAgent(r), "utf8") + "\n<!-- my local edit -->\n"; // local != upstream, != base
  writeFileSync(auditorAgent(r), edited);
  const u = crew(r, "update", "auditor");
  assert.equal(u.status, 1, "conflict aborts");
  assert.match(u.stdout, /conflict/i);
  assert.match(u.stdout, /modified-both/);
  assert.equal(readFileSync(auditorAgent(r), "utf8"), edited, "local file untouched (nothing written)");
});

test("crew update: a local-only edit is preserved when upstream is unchanged", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  const brief = join(r, "bureau", "crew", "auditor", "brief.md");
  writeFileSync(brief, readFileSync(brief, "utf8") + "\n<!-- my note -->\n"); // local-only edit; base still original
  const chk = crew(r, "update", "auditor", "--check");
  assert.equal(chk.status, 0, "no upstream change → nothing pending");
  assert.match(chk.stdout, /up-to-date/);
  assert.equal(crew(r, "update", "auditor").status, 0);
  assert.ok(readFileSync(brief, "utf8").includes("<!-- my note -->"), "local edit preserved through update");
});

test("crew update: a shipped member with no upstream is 'untracked' — reported, never auto-baselined", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  const cj = JSON.parse(readFileSync(auditorCj(r), "utf8")); delete cj.upstream; // simulate a pre-tracking install
  writeFileSync(auditorCj(r), JSON.stringify(cj, null, 2) + "\n");
  const chk = crew(r, "update", "auditor", "--check");
  assert.equal(chk.status, 0, "untracked is not a pending update");
  assert.match(chk.stdout, /untracked/);
  assert.match(chk.stdout, /disable --purge/);
  assert.equal(crew(r, "update", "auditor").status, 0);
  assert.ok(!JSON.parse(readFileSync(auditorCj(r), "utf8")).upstream, "no baseline written — stays untracked until re-enabled");
});

test("crew update: a stale/converged base is advanced even with no file changes (no phantom future conflict)", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  setBaseSha(r, "agent.md", sha256("stale-old-base")); // local still equals upstream (converged), base is stale
  const chk = crew(r, "update", "auditor", "--check");
  assert.equal(chk.status, 1, "a stale base is a pending update");
  assert.match(chk.stdout, /base reconciled/);
  const before = readFileSync(auditorAgent(r), "utf8");
  assert.equal(crew(r, "update", "auditor").status, 0);
  assert.equal(readFileSync(auditorAgent(r), "utf8"), before, "no file changes — only the base advanced");
  assert.equal(crew(r, "update", "auditor", "--check").status, 0, "up-to-date after reconcile");
});

test("crew update: a file upstream no longer ships (in base+local, untouched) is deleted locally", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  const extra = join(r, "bureau", "crew", "auditor", "extra.md");
  writeFileSync(extra, "extra content\n");
  const cj = JSON.parse(readFileSync(auditorCj(r), "utf8"));
  cj.upstream.base["extra.md"] = sha256("extra content\n");         // base+local have it; upstream does not
  writeFileSync(auditorCj(r), JSON.stringify(cj, null, 2) + "\n");
  assert.equal(crew(r, "update", "auditor").status, 0);
  assert.ok(!existsSync(extra), "upstream-removed file deleted locally");
  assert.equal(crew(r, "check").status, 0);
});

test("crew update: a file the base/local lack but upstream ships is added locally", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  const brief = join(r, "bureau", "crew", "auditor", "brief.md");
  rmSync(brief);                                                    // drop brief from base + local...
  const cj = JSON.parse(readFileSync(auditorCj(r), "utf8"));
  delete cj.upstream.base["brief.md"];
  writeFileSync(auditorCj(r), JSON.stringify(cj, null, 2) + "\n");
  assert.equal(crew(r, "update", "auditor").status, 0);            // ...so upstream's brief looks added
  assert.ok(existsSync(brief), "upstream-added file created locally");
  assert.equal(crew(r, "check").status, 0);
});

test("crew update: an unsafe upstream.template is rejected (no path traversal), reported as unavailable", (t) => {
  const r = repo(t); crew(r, "enable", "auditor");
  const cj = JSON.parse(readFileSync(auditorCj(r), "utf8"));
  cj.upstream.template = "../../../../etc";                         // untrusted crew.json must not drive a path outside PLUGIN/crew
  writeFileSync(auditorCj(r), JSON.stringify(cj, null, 2) + "\n");
  const u = crew(r, "update", "auditor", "--check");
  assert.equal(u.status, 0, "unsafe template → unavailable (not a pending update), no crash");
  assert.match(u.stdout, /unavailable|can't track/);
});

test("crew update: a local member has no upstream — reported and skipped", (t) => {
  const r = repo(t);
  assert.equal(crew(r, "new", "scribe-helper", "--role", "drafts").status, 0);
  const u = crew(r, "update", "scribe-helper");
  assert.equal(u.status, 0);
  assert.match(u.stdout, /local/);
});
