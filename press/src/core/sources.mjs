// core/sources — file discovery for the SSOT. The content dir (default `gazette/`)
// is walked RECURSIVELY: subfolders become nav sections (see model.mjs), so docs are
// returned as paths RELATIVE to the content dir (posix-style, e.g. "characters/lin.html").
// `_`-prefixed and dotfiles/dirs are skipped — that's where _config.json, _types/, and
// _data/ live (all inside the content dir now). Pure listing; parsing is in model.mjs.
import { readdirSync, existsSync, lstatSync, readFileSync } from "fs";
import { join, relative, sep, basename } from "path";

// reserved non-content dirs: build output, deps. (Top-level control/output dirs — `crew/` and, in
// the CONTAINED layout, the configured board — are skipped via topLevelSkips(); a nested dir named
// crew, e.g. `characters/crew/`, still renders.)
const skipDir = (n) => n.startsWith("_") || n.startsWith(".") || n === "dist" || n === "node_modules";
const relPosix = (base, p) => relative(base, p).split(sep).join("/");

// Names a board dir may NEVER take: in the CONTAINED layout the board renders INSIDE the workspace
// and the atomic swap deletes whatever sits at the target, so a board that aliases a control/source
// dir (or the marker file) would erase it. `_`/`.`-prefixed names are refused too — they alias the
// state ledgers (`_log.jsonl`, `_config.json`, `_types/`, `_data/`) and dotfiles. Runtime defense
// in depth: bureau:init already rejects these, but a hand-edited/corrupted marker must fail safe.
const RESERVED_BOARD = new Set(["crew", "logbook", "lint", "dist", "node_modules", "bureau.json"]);
const safeBoard = (b) =>
  typeof b === "string" && /^[A-Za-z0-9._-]+$/.test(b) && b !== "." && b !== ".."
  && !b.startsWith("_") && !b.startsWith(".") && !RESERVED_BOARD.has(b)
    ? b : "gazette"; // fail safe to the default — never a name that could clobber source/control

// A bureau WORKSPACE is marked by a `bureau.json` child. Returns its configured board dir name
// (`board`, default "gazette"), or null when the marker is absent, a symlink, unreadable/malformed,
// or not a JSON object. A corrupt marker FAILS CLOSED (null): the caller then grants NO contained
// exemption and the guard refuses to render into the workspace — rather than silently defaulting to
// "gazette" and letting the swap delete a `bureau/gazette/` that a since-corrupted custom `board`
// had left as ordinary content. A well-formed marker whose `board` is unsafe or reserved still fails
// safe to "gazette" (see safeBoard) — there the board name is known, just not an allowed target.
export function boardDirName(docsDir) {
  const p = join(docsDir, "bureau.json");
  let st; try { st = lstatSync(p); } catch { return null; } // no marker → not a bureau workspace
  if (st.isSymbolicLink()) return null;
  let cfg; try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { return null; } // corrupt marker → fail closed
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;             // non-object marker → fail closed
  return safeBoard(cfg.board); // valid object: a safe, non-reserved board — else the default "gazette"
}

// The CONTAINED layout is a workspace NAMED `bureau` (bureau:init --workspace bureau): its board
// renders INSIDE the workspace at `<workspace>/<board>`, the ONE case where the board lives under
// the content root. Returns that board dir name for a contained workspace (basename `bureau`, NOT a
// symlink, AND a marker naming the board), else null. A default-layout workspace (`canon`, …)
// renders its board OUTSIDE itself, so nothing inside it is ever the board — its board name is NOT
// special here, and a `<workspace>/<board>/` subdir there stays ordinary content. The symlink
// guard stops a link named `bureau` from spoofing the (lexical) name gate onto another physical
// dir — matching the symlinked-root policy in build.mjs hashInputs and boardDirName's marker check.
export function containedBoardDir(docsDir) {
  if (basename(docsDir) !== "bureau") return null;
  try { if (lstatSync(docsDir).isSymbolicLink()) return null; } catch { return null; }
  return boardDirName(docsDir);
}

// Build the top-level skip set from an ALREADY-RESOLVED contained board name (or null): the crew
// source dir (bureau's control plane — always skipped) and, in the CONTAINED layout, the board dir
// plus its atomic-swap siblings (`<board>.tmp` / `<board>.bak`). A build resolves the board ONCE
// (containedBoardDir) and passes it here, so guard, input hash, and discovery share one snapshot —
// a `bureau.json` edit mid-build can't make them skip different dirs.
export function topLevelSkipsFor(board) {
  const skips = new Set(["crew"]);
  if (board) { skips.add(board); skips.add(board + ".tmp"); skips.add(board + ".bak"); }
  return skips;
}

// Convenience for one-shot callers that don't snapshot the board themselves: resolve it and build
// the skip set. Keyed on containedBoardDir, so a default-layout board name is never skipped.
export function topLevelSkips(docsDir) {
  return topLevelSkipsFor(containedBoardDir(docsDir));
}

// recursively collect files under `dir` whose basename matches `pred`, as relative paths.
// Uses lstat and SKIPS symlinks (files and dirs) so discovery can't follow a link out of
// the content tree or loop through a symlink cycle. `topSkip` names entries skipped at the
// TOP level only (crew + the workspace's own board — see topLevelSkips). The skip is applied
// BEFORE the file/dir branch — same as build.mjs hashInputs — so a board configured to a
// file-shaped name (e.g. `notes.md`) is excluded from discovery AND the hash identically; a
// name read as content by one but skipped by the other would break the cache/clobber invariant.
function walk(dir, base, pred, acc, topSkip) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    if (dir === base && topSkip.has(name)) continue; // top-level control/board — files AND dirs
    const p = join(dir, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!skipDir(name)) walk(p, base, pred, acc, topSkip); }
    else if (st.isFile() && pred(name)) acc.push(relPosix(base, p));
  }
  return acc;
}

export function discover({ docsDir, dataDir, topSkip = null }) {
  const typesDir = join(docsDir, "_types");
  const ddir = dataDir || join(docsDir, "_data"); // data now lives under the content dir
  const isFile = (dir) => (f) => { try { return lstatSync(join(dir, f)).isFile(); } catch { return false; } }; // lstat: skip symlinked entries
  // child entries are lstat-filtered, but a symlinked ROOT (_types/_data itself) would still be
  // walked — read from outside the tree. Treat a symlinked directory root as absent.
  const realDir = (dir) => { try { return existsSync(dir) && !lstatSync(dir).isSymbolicLink(); } catch { return false; } };
  const lsTop = (dir, pred) => (realDir(dir) ? readdirSync(dir).filter((f) => pred(f) && isFile(dir)(f)).sort() : []);
  // crew + (in the contained layout) the configured board. A build passes its one snapshot; a
  // one-shot caller (e.g. `gazette health`) omits it and we resolve it here.
  const skip = topSkip || topLevelSkips(docsDir);
  return {
    docsDir,
    typesDir,
    dataDir: ddir,
    docFiles: walk(docsDir, docsDir, (f) => (f.endsWith(".html") || f.endsWith(".md")) && !f.startsWith("_"), [], skip),   // HTML + Markdown, recursive
    canvasFiles: walk(docsDir, docsDir, (f) => f.endsWith(".canvas") && !f.startsWith("_"), [], skip),
    typeFiles: lsTop(typesDir, (f) => f.endsWith(".html")),
    dataFiles: lsTop(ddir, (f) => !f.startsWith(".")),
  };
}
