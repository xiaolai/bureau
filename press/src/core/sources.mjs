// core/sources — file discovery for the SSOT. The content dir (default `gazette/`)
// is walked RECURSIVELY: subfolders become nav sections (see model.mjs), so docs are
// returned as paths RELATIVE to the content dir (posix-style, e.g. "characters/lin.html").
// `_`-prefixed and dotfiles/dirs are skipped — that's where _config.json, _types/, and
// _data/ live (all inside the content dir now). Pure listing; parsing is in model.mjs.
import { readdirSync, existsSync, lstatSync } from "fs";
import { join, relative, sep } from "path";

// reserved non-content dirs: build output, deps. (A TOP-LEVEL `crew/` — bureau's control dir — is
// skipped separately in walk(); a nested dir named crew, e.g. `characters/crew/`, still renders.)
const skipDir = (n) => n.startsWith("_") || n.startsWith(".") || n === "dist" || n === "node_modules";
const relPosix = (base, p) => relative(base, p).split(sep).join("/");

// recursively collect files under `dir` whose basename matches `pred`, as relative paths.
// Uses lstat and SKIPS symlinks (files and dirs) so discovery can't follow a link out of
// the content tree or loop through a symlink cycle.
function walk(dir, base, pred, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!skipDir(name) && !(name === "crew" && dir === base)) walk(p, base, pred, acc); }
    else if (st.isFile() && pred(name)) acc.push(relPosix(base, p));
  }
  return acc;
}

export function discover({ docsDir, dataDir }) {
  const typesDir = join(docsDir, "_types");
  const ddir = dataDir || join(docsDir, "_data"); // data now lives under the content dir
  const isFile = (dir) => (f) => { try { return lstatSync(join(dir, f)).isFile(); } catch { return false; } }; // lstat: skip symlinked entries
  const lsTop = (dir, pred) => (existsSync(dir) ? readdirSync(dir).filter((f) => pred(f) && isFile(dir)(f)).sort() : []);
  return {
    docsDir,
    typesDir,
    dataDir: ddir,
    docFiles: walk(docsDir, docsDir, (f) => (f.endsWith(".html") || f.endsWith(".md")) && !f.startsWith("_"), []),   // HTML + Markdown, recursive
    canvasFiles: walk(docsDir, docsDir, (f) => f.endsWith(".canvas") && !f.startsWith("_"), []),
    typeFiles: lsTop(typesDir, (f) => f.endsWith(".html")),
    dataFiles: lsTop(ddir, (f) => !f.startsWith(".")),
  };
}
