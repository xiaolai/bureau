// Contained layout: a bureau workspace NAMED `bureau` hosts the crew source (crew/) and its own
// rendered board (<workspace>/<board>, bureau.json `board`, default "gazette") as top-level
// children. The press must (a) treat both as non-content, (b) permit exactly the board child as
// --out (guardOutDir), and (c) keep the incremental cache stable across a board rebuild — the
// board output must never feed back into the next build's input hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.mjs";
import { boardDirName, containedBoardDir, topLevelSkips, topLevelSkipsFor } from "../src/core/sources.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const NOW = "2026-06-09";

// an init-equivalent contained fixture: bureau/ = workspace (marker) + nested crew source. The
// crew page's title COLLIDES with real content on purpose — if the walk ever read crew/ (or a
// board dir seeded the same way), the build would throw a duplicate-title error, so "renders
// content but not crew/board" is asserted structurally, not just by count.
function containedRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "wb-contained-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "bureau");
  mkdirSync(join(ws, "crew", "auditor"), { recursive: true });
  writeFileSync(join(ws, "bureau.json"), JSON.stringify({ workspace: "bureau", board: "gazette" }));
  writeFileSync(join(ws, "00-overview.md"), "---\ntitle: Overview\n---\n# Overview\nsee [[Second]]\n");
  writeFileSync(join(ws, "second.md"), "---\ntitle: Second\n---\n# Second\nback to [[Overview]]\n");
  writeFileSync(join(ws, "crew", "auditor", "agent.md"), "---\ntitle: Overview\n---\ncrew source, not content\n");
  return { root, ws };
}

test("contained: builds into <workspace>/<board>; crew/ and the board are not content; cache stays stable", (t) => {
  const { root, ws } = containedRepo(t);
  const out = join(ws, "gazette");
  const r = buildSite({ root, docsDir: ws, outDir: out, now: NOW });
  assert.equal(r.fileDocCount, 2, "only the two content pages render (crew/ skipped — its colliding title never loaded)");
  assert.ok(existsSync(join(out, "index.html")), "the board rendered inside the workspace");
  // the board output just written INSIDE the workspace must not feed back as build input
  const again = buildSite({ root, docsDir: ws, outDir: out, now: NOW });
  assert.equal(again.cached, true, "rebuild is a cache hit — the nested board is excluded from the input hash");
  // …while a REAL content change still invalidates
  appendFileSync(join(ws, "second.md"), "\nmore prose\n");
  assert.notEqual(buildSite({ root, docsDir: ws, outDir: out, now: NOW }).cached, true, "a content edit still rebuilds");
});

test("contained: pages inside the board dir (and crashed-swap leftovers) are never read as content", (t) => {
  const { root, ws } = containedRepo(t);
  // stale board leftovers + a crashed build's swap sibling, each with a COLLIDING title
  mkdirSync(join(ws, "gazette"), { recursive: true });
  writeFileSync(join(ws, "gazette", "stale.md"), "---\ntitle: Overview\n---\nstale board page\n");
  mkdirSync(join(ws, "gazette.tmp"), { recursive: true });
  writeFileSync(join(ws, "gazette.tmp", "half.md"), "---\ntitle: Second\n---\ncrashed-build leftover\n");
  const r = buildSite({ root, docsDir: ws, outDir: join(ws, "gazette"), now: NOW });
  assert.equal(r.fileDocCount, 2, "board dir + swap siblings are excluded from discovery");
});

test("contained: only the CONFIGURED board child is permitted inside the workspace", (t) => {
  const { root, ws } = containedRepo(t);
  // a non-board child of the workspace is still a refused overlap…
  assert.throws(() => buildSite({ root, docsDir: ws, outDir: join(ws, "logbook"), now: NOW }), /overlaps the content dir/);
  // …as is the workspace itself…
  assert.throws(() => buildSite({ root, docsDir: ws, outDir: ws, now: NOW }), /overlaps the content dir/);
  // …and a non-marker content dir keeps the old absolute rule (no bureau.json ⇒ no exception)
  const plain = join(root, "plain");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "a.md"), "---\ntitle: A\n---\nbody\n");
  assert.throws(() => buildSite({ root, docsDir: plain, outDir: join(plain, "gazette"), now: NOW }), /overlaps the content dir/);
});

test("contained: the CLI auto-detects a workspace named `bureau` via its marker", (t) => {
  const { root } = containedRepo(t);
  // no --dir: contentDir() must resolve bureau/ (the single */bureau.json child), and health must
  // load only the two mutually-linked content pages (exit 0 ⇒ no dangling/orphans, no dup titles).
  const out = execFileSync("node", [CLI, "health"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /dangling links\s*:\s*0/, "rendered the contained workspace successfully");
});

test("contained: name-gated — a default-layout marked workspace does NOT exempt its board name", (t) => {
  // The exemption is the CONTAINED layout alone (a workspace named `bureau`), NOT any bureau.json-
  // marked dir. A default-layout workspace (`canon`) renders its board OUTSIDE itself, so a
  // `<workspace>/<board>/` subdir is ordinary content and may never be the --out target.
  const root = mkdtempSync(join(tmpdir(), "wb-default-marked-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "canon");
  mkdirSync(join(ws, "gazette"), { recursive: true });
  writeFileSync(join(ws, "bureau.json"), JSON.stringify({ workspace: "canon", board: "gazette" }));
  writeFileSync(join(ws, "00-overview.md"), "---\ntitle: Overview\n---\n# Overview\n");
  writeFileSync(join(ws, "gazette", "inside.md"), "---\ntitle: Inside The Board Name\n---\nordinary content, not a render\n");
  // the board name is NOT skipped in a default-layout workspace → the subdir page renders as content
  const r = buildSite({ root, docsDir: ws, outDir: join(root, "gazette"), now: NOW });
  assert.equal(r.fileDocCount, 2, "a default-layout `<workspace>/gazette/` subdir is ordinary content (not exempt)");
  // …and it is NOT a permitted --out: it overlaps the content dir like any other child
  assert.throws(() => buildSite({ root, docsDir: ws, outDir: join(ws, "gazette"), now: NOW }), /overlaps the content dir/);
});

// --- board-name hardening + name-gate spoofing (audit follow-ups) ---

// a contained workspace (dir named `bureau`) with a given board + seeded files
function boardWs(t, board, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "wb-bh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "bureau");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "bureau.json"), JSON.stringify({ workspace: "bureau", board }));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), body); }
  return { root, ws };
}

test("contained: boardDirName sanitizes unsafe/reserved board names to the safe default", (t) => {
  // In the contained layout the board is rendered (and swap-deleted) in place, so a board aliasing a
  // control/source dir, the marker, a state ledger, or a path-unsafe value would erase it. All must
  // fail safe to "gazette"; only a safe, non-reserved segment passes through.
  const root = mkdtempSync(join(tmpdir(), "wb-board-san-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "bureau");
  mkdirSync(ws, { recursive: true });
  const setBoard = (b) => writeFileSync(join(ws, "bureau.json"), JSON.stringify(b === undefined ? { workspace: "bureau" } : { workspace: "bureau", board: b }));
  for (const bad of ["crew", "logbook", "lint", "bureau.json", "_types", "_data", ".git", "..", ".", "a/b", "../evil", "", 42, null, undefined]) {
    setBoard(bad);
    assert.equal(boardDirName(ws), "gazette", `board ${JSON.stringify(bad)} fails safe to gazette`);
  }
  for (const ok of ["gazette", "site", "board", "my-board", "board.v2"]) {
    setBoard(ok);
    assert.equal(boardDirName(ws), ok, `safe board ${JSON.stringify(ok)} is honored`);
  }
  setBoard("site");
  assert.equal(containedBoardDir(ws), "site", "containedBoardDir surfaces the sanitized board for a real bureau workspace");
});

test("contained: a reserved board (crew) is neutralized — the crew source can't be clobbered", (t) => {
  // A hand-edited marker asking to render the board over `crew` must not erase the crew source: the
  // sanitizer collapses board→gazette, so the exemption is bureau/gazette and rendering to the raw
  // bureau/crew is refused as a content overlap. Defense in depth beyond init's validation.
  const { root, ws } = boardWs(t, "crew", {
    "crew/auditor/agent.md": "---\ntitle: Crew\n---\ncontrol source\n",
    "a.md": "---\ntitle: A\n---\nbody\n",
  });
  assert.equal(containedBoardDir(ws), "gazette", "reserved board collapses to the safe default");
  assert.throws(() => buildSite({ root, docsDir: ws, outDir: join(ws, "crew"), now: NOW }), /overlaps the content dir/,
    "rendering the board over the crew source is refused");
  assert.ok(existsSync(join(ws, "crew", "auditor", "agent.md")), "the crew source survives");
});

test("contained: a non-default board name is honored end-to-end (not hard-coded to gazette)", (t) => {
  // proves board resolution reads the marker: the board nests at bureau/site, that child is
  // non-content + excluded from the input hash, and a different child is NOT a permitted --out.
  const { root, ws } = boardWs(t, "site", { "00-overview.md": "---\ntitle: Overview\n---\n# Overview\n" });
  const out = join(ws, "site");
  const r = buildSite({ root, docsDir: ws, outDir: out, now: NOW });
  assert.equal(r.fileDocCount, 1, "the one content page renders");
  assert.ok(existsSync(join(out, "index.html")), "board rendered at the configured child bureau/site");
  assert.equal(buildSite({ root, docsDir: ws, outDir: out, now: NOW }).cached, true, "the nested board is excluded from the input hash");
  assert.throws(() => buildSite({ root, docsDir: ws, outDir: join(ws, "gazette"), now: NOW }), /overlaps the content dir/,
    "a child other than the configured board is not a permitted --out");
});

test("contained: a file-shaped board name is skipped from discovery AND the hash alike (symmetry)", (t) => {
  // board:"notes.md" collides with a top-level content file. walk() and hashInputs must BOTH skip it
  // (skip decided before the file/dir branch), else the file is read as content by one and excluded
  // by the other. The colliding file carries a duplicate title — if it were read, the build throws.
  const { root, ws } = boardWs(t, "notes.md", {
    "00-overview.md": "---\ntitle: Overview\n---\n# Overview\n",
    "notes.md": "---\ntitle: Overview\n---\nwould be a DUPLICATE title if read as content\n",
  });
  const out = join(root, "out"); // render OUTSIDE the workspace so we assert discovery/hash, not the swap
  const r = buildSite({ root, docsDir: ws, outDir: out, now: NOW });
  assert.equal(r.fileDocCount, 1, "the board-named top-level FILE is excluded from discovery (no dup-title throw)");
  // hash symmetry: the file is out of the input hash too, so editing it must NOT invalidate the cache
  assert.equal(buildSite({ root, docsDir: ws, outDir: out, now: NOW }).cached, true, "rebuild is a cache hit");
  appendFileSync(join(ws, "notes.md"), "\nedit to the board-named file\n");
  assert.equal(buildSite({ root, docsDir: ws, outDir: out, now: NOW }).cached, true, "editing the board-named file does NOT invalidate the cache (excluded from the hash, exactly as from discovery)");
  appendFileSync(join(ws, "00-overview.md"), "\nreal edit\n"); // …while a REAL content edit still rebuilds
  assert.notEqual(buildSite({ root, docsDir: ws, outDir: out, now: NOW }).cached, true, "a real content edit still invalidates");
});

test("contained: a corrupt marker fails closed — no board resolution, no destructive exemption", (t) => {
  // F2: a custom board (e.g. bureau/site) leaves bureau/gazette as ordinary content. A LATER marker
  // corruption must NOT silently fall back to board="gazette" (which the swap would then delete).
  // boardDirName + containedBoardDir both return null for an unparseable or non-object marker, so the
  // guard grants no exemption and refuses to render into the workspace at all — data loss impossible.
  const root = mkdtempSync(join(tmpdir(), "wb-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "bureau");
  mkdirSync(ws, { recursive: true });
  const marker = join(ws, "bureau.json");
  for (const bad of ["{ not json", "42", '"a string"', "[1,2,3]", "null"]) {
    writeFileSync(marker, bad);
    assert.equal(boardDirName(ws), null, `corrupt marker ${JSON.stringify(bad)} → boardDirName null`);
    assert.equal(containedBoardDir(ws), null, `corrupt marker ${JSON.stringify(bad)} → no exemption`);
  }
  writeFileSync(marker, JSON.stringify({ workspace: "bureau" })); // a valid marker with no board key…
  assert.equal(containedBoardDir(ws), "gazette", "…still defaults to gazette (the normal contained case)");
  writeFileSync(marker, "{ corrupt"); // and a corrupt-marker workspace refuses to render into itself
  writeFileSync(join(ws, "a.md"), "---\ntitle: A\n---\nbody\n");
  assert.throws(() => buildSite({ root, docsDir: ws, outDir: join(ws, "gazette"), now: NOW }), /overlaps the content dir/,
    "a corrupt-marker contained workspace refuses to render into itself");
});

test("contained: board dir and BOTH swap siblings (.tmp/.bak) are excluded from discovery", (t) => {
  const { root, ws } = containedRepo(t);
  for (const d of ["gazette", "gazette.tmp", "gazette.bak"]) {
    mkdirSync(join(ws, d), { recursive: true });
    writeFileSync(join(ws, d, "leftover.md"), "---\ntitle: Overview\n---\ncolliding-title leftover in " + d + "\n");
  }
  // render OUTSIDE the workspace so no swap touches the leftovers; discovery must still skip all three
  const r = buildSite({ root, docsDir: ws, outDir: join(root, "out"), now: NOW });
  assert.equal(r.fileDocCount, 2, "board dir + .tmp + .bak siblings all excluded (else the colliding titles throw)");
});

test("contained: topLevelSkipsFor builds the skip set from a resolved board (one build-time snapshot)", (t) => {
  // The build resolves the board ONCE and passes it to guard + hash + discovery via topLevelSkipsFor,
  // so a mid-build marker edit can't make them skip different dirs. The snapshot path must match the
  // resolve-each-time convenience (topLevelSkips) for the same workspace.
  assert.deepEqual([...topLevelSkipsFor("gazette")].sort(), ["crew", "gazette", "gazette.bak", "gazette.tmp"]);
  assert.deepEqual([...topLevelSkipsFor("site")].sort(), ["crew", "site", "site.bak", "site.tmp"]);
  assert.deepEqual([...topLevelSkipsFor(null)].sort(), ["crew"], "no contained board → only crew is skipped");
  const { ws } = boardWs(t, "site", {});
  assert.deepEqual([...topLevelSkipsFor(containedBoardDir(ws))].sort(), [...topLevelSkips(ws)].sort(),
    "snapshot path and resolve-each-time path agree for the same workspace");
});

test("contained: a symlink named `bureau` cannot spoof the name gate", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wb-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "bureau.json"), JSON.stringify({ workspace: "bureau", board: "gazette" }));
  const link = join(root, "bureau");
  symlinkSync(real, link); // lexical basename is `bureau`, but it is a symlink onto a differently-named dir
  assert.equal(containedBoardDir(link), null, "a symlinked `bureau` root is not treated as contained");
  assert.equal(containedBoardDir(real), null, "a non-`bureau` basename is never contained");
});
