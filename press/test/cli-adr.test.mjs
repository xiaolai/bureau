// WI-6 (ADR layer) — `gazette adr new`. Spawns the REAL CLI in a tmpdir workspace. The load-bearing
// guarantee is the write-gate: it authors a PROPOSED source file and NEVER touches _log.jsonl, never
// approves, never passes --by. Real process + real fs; no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");

function ws(t) {
  const root = mkdtempSync(join(tmpdir(), "wb-cli-adr-"));
  const dir = join(root, "canon"); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir };
}
function adr(dir, args) {
  const r = spawnSync("node", [CLI, "adr", "new", ...args, "--dir", dir], { encoding: "utf8" });
  return { code: r.status ?? 0, out: (r.stdout || "") + (r.stderr || "") };
}
const decisionsFiles = (dir) => { const d = join(dir, "decisions"); return existsSync(d) ? readdirSync(d) : []; };
const onlyDecision = (dir) => readFileSync(join(dir, "decisions", decisionsFiles(dir)[0]), "utf8");

test("6.1 adr new writes a proposed kind:adr page under decisions/, prints path+number, no log", (t) => {
  const { dir } = ws(t);
  const r = adr(dir, ["--title", "Use X"]);
  assert.equal(r.code, 0);
  const files = decisionsFiles(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^ADR-0001/);
  const text = onlyDecision(dir);
  assert.match(text, /^status:\s*proposed$/m);
  assert.match(text, /^kind:\s*adr$/m);
  assert.match(r.out, /ADR-0001/); // stdout mentions the number/path
  assert.ok(!existsSync(join(dir, "_log.jsonl")), "the decision log is never created");
});

test("6.2 adr new does NOT append to a pre-existing _log.jsonl (byte-identical)", (t) => {
  const { dir } = ws(t);
  const logFile = join(dir, "_log.jsonl");
  writeFileSync(logFile, '{"seq":1,"type":"note"}\n');
  const before = readFileSync(logFile, "utf8");
  assert.equal(adr(dir, ["--title", "Use X"]).code, 0);
  assert.equal(readFileSync(logFile, "utf8"), before, "the log is untouched — no decision path is imported");
});

test("6.3 adr new numbers max+1 against existing workspace ADRs", (t) => {
  const { dir } = ws(t);
  assert.equal(adr(dir, ["--title", "First"]).code, 0);
  assert.equal(adr(dir, ["--title", "Second"]).code, 0);
  const r = adr(dir, ["--title", "Third"]);
  assert.equal(r.code, 0);
  assert.ok(decisionsFiles(dir).some((f) => /^ADR-0003/.test(f)), "the third ADR is numbered 3");
});

test("6.4 adr new --supersedes ADR-0001 resolves to that page's TITLE", (t) => {
  const { dir } = ws(t);
  assert.equal(adr(dir, ["--title", "Foo Decision"]).code, 0); // → ADR-0001 — Foo Decision
  assert.equal(adr(dir, ["--title", "Bar", "--supersedes", "ADR-0001"]).code, 0);
  const bar = readFileSync(join(dir, "decisions", decisionsFiles(dir).find((f) => /^ADR-0002/.test(f))), "utf8");
  assert.ok(bar.includes('supersedes: "[[ADR-0001 — Foo Decision]]"'), "resolves the ADR token to the real target title");
});

test("6.5 adr new --supersedes on an unknown ADR fails loudly and writes nothing", (t) => {
  const { dir } = ws(t);
  const before = decisionsFiles(dir).length;
  const r = adr(dir, ["--title", "X", "--supersedes", "ADR-9999"]);
  assert.notEqual(r.code, 0);
  assert.equal(decisionsFiles(dir).length, before, "no file is written when --supersedes cannot resolve");
});

test("6.6 adr new refuses to overwrite an existing file (O_EXCL) or a symlinked target (O_NOFOLLOW)", (t) => {
  // (a) a plain file already at the computed target path (title "X" → decisions/ADR-0001-x.md)
  const a = ws(t);
  mkdirSync(join(a.dir, "decisions"), { recursive: true });
  const targetA = join(a.dir, "decisions", "ADR-0001-x.md");
  writeFileSync(targetA, "---\ntitle: Placeholder\n---\n# Placeholder\nkeep me\n");
  const ra = adr(a.dir, ["--title", "X"]);
  assert.notEqual(ra.code, 0);
  assert.match(readFileSync(targetA, "utf8"), /keep me/, "an existing file is never clobbered (O_EXCL)");

  // (b) the computed target path is a symlink → O_NOFOLLOW refuses the write-through
  const b = ws(t);
  mkdirSync(join(b.dir, "decisions"), { recursive: true });
  const decoy = join(b.root, "decoy.txt");
  writeFileSync(decoy, "DECOY");
  symlinkSync(decoy, join(b.dir, "decisions", "ADR-0001-x.md"));
  const rb = adr(b.dir, ["--title", "X"]);
  assert.notEqual(rb.code, 0);
  assert.equal(readFileSync(decoy, "utf8"), "DECOY", "a symlinked target is refused, not written through (O_NOFOLLOW)");
});

test("6.7 adr new never emits --by / approve / canonical anywhere (file or stdout)", (t) => {
  const { dir } = ws(t);
  const r = adr(dir, ["--title", "X"]);
  assert.equal(r.code, 0);
  const both = onlyDecision(dir) + "\n" + r.out;
  assert.doesNotMatch(both, /--by|approve|canonical/i);
});

test("6.8 the freshly scaffolded page passes gazette fsck (ok:true)", (t) => {
  const { dir } = ws(t);
  assert.equal(adr(dir, ["--title", "X"]).code, 0);
  spawnSync("node", [CLI, "scan", "--dir", dir], { encoding: "utf8" });
  const f = spawnSync("node", [CLI, "fsck", "--dir", dir], { encoding: "utf8" });
  assert.equal(f.status, 0, "a proposed ADR page backs nothing — fsck stays ok:true");
});

// ── WI-9 (ADR layer): the MADR Confirmation → ledger verify drift gate, end to end ──
test("9.3 e2e: adr new → ledger verify the Confirmation artifact → mutate it → ledger recheck exits non-zero", (t) => {
  const { root, dir } = ws(t);
  assert.equal(adr(dir, ["--title", "Foo"]).code, 0);
  const created = readFileSync(join(dir, "decisions", decisionsFiles(dir)[0]), "utf8");
  const title = /^title:\s*(.+)$/m.exec(created)[1].trim(); // the numbered ADR title (with em-dash)
  writeFileSync(join(root, "confirm.txt"), "the ADR's Confirmation artifact — original");
  // ledger verify/recheck resolve the artifact relative to cwd (the workspace root) and key by page title
  const gz = (args) => spawnSync("node", [CLI, ...args, "--dir", dir], { cwd: root, encoding: "utf8" });
  assert.equal(gz(["ledger", "verify", "--page", title, "--artifact", "confirm.txt", "--claim", "confirms the decision"]).status, 0);
  writeFileSync(join(root, "confirm.txt"), "CHANGED — the confirmation drifted; this ADR needs re-review");
  assert.notEqual(gz(["ledger", "recheck", "--page", title]).status, 0, "a drifted Confirmation artifact fails recheck (drift gate)");
});

// ── audit-fix: numbering + --supersedes ignore a page that merely MENTIONS an ADR (anchored match) ──
test("adr new: a page mentioning ADR-NNNN is not counted, and --supersedes resolves the REAL ADR", (t) => {
  const { dir } = ws(t);
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "distractor.md"), "---\nid: DIS\ntitle: About ADR-0001 and its rationale\n---\n# About ADR-0001\nprose ^d\n");
  assert.equal(adr(dir, ["--title", "First"]).code, 0);   // the distractor is NOT counted → this is ADR-0001
  assert.ok(decisionsFiles(dir).some((f) => /^ADR-0001/.test(f)), "the mention did not inflate the number");
  assert.equal(adr(dir, ["--title", "Second", "--supersedes", "ADR-0001"]).code, 0);
  const second = readFileSync(join(dir, "decisions", decisionsFiles(dir).find((f) => /^ADR-0002/.test(f))), "utf8");
  assert.ok(second.includes("[[ADR-0001 — First]]"), "--supersedes resolves to the real ADR, not the mentioning page");
});

// ── audit-fix: a corpus/model error is reported cleanly (die), never a raw uncaught stack trace ──
test("adr new: a corpus error (duplicate _types schema) is reported via die(), not an uncaught stack trace", (t) => {
  const { dir } = ws(t);
  mkdirSync(join(dir, "_types"), { recursive: true });
  writeFileSync(join(dir, "_config.json"), JSON.stringify({ meta: { home: "" } }));
  writeFileSync(join(dir, "_types", "a.html"), "---\napplies: g\nedges: [x]\n---\n<p>one</p>");
  writeFileSync(join(dir, "_types", "b.html"), "---\napplies: g\nedges: [y]\n---\n<p>two</p>"); // duplicate group → buildModel throws
  const r = adr(dir, ["--title", "X"]);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /\n\s+at .+:\d+:\d+/, "no raw stack frames — the error is caught and reported via die()");
});
