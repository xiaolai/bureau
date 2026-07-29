#!/usr/bin/env node
// bureau:pair — add/update a USER-LOCAL workspace mapping entry (ADR-0003).
//
// This is the ONLY writer of ~/.config/bureau/workspaces.json. It applies the SAME target controls
// the hooks/CLI use at read time (validateWorkspaceTarget), then writes the file 0600. A code repo's
// committed .bureau-id names WHICH workspace; this pairs that name to WHERE it lives on THIS machine
// — an explicit, user-run step. Nothing auto-maps.
//
//   node pair.mjs <bureau-id> <workspace-path>
//
// The target must already exist as a real (non-symlink) workspace (a bureau.json marker) under an
// allowed root (~/bureaus by default, or a root listed in the config), owned by you, not
// group/other-writable. On a fresh clone: clone/restore the workspace first, then pair it.
import { existsSync, mkdirSync, renameSync, lstatSync, openSync, writeSync, closeSync, constants as FS } from "fs";
import { dirname } from "path";
import { configPath, loadWorkspaceMap, validateWorkspaceTarget } from "../press/src/core/workspace-map.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const die = (m) => { process.stderr.write("✗ " + m + "\n"); process.exit(1); };
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };

const [, , id, path] = process.argv;
if (!id || !path) die("usage: node pair.mjs <bureau-id> <workspace-path>");
if (!ID_RE.test(id)) die("bureau-id must be an opaque token [A-Za-z0-9._-] (no path separators): " + id);

let loaded;
try { loaded = loadWorkspaceMap(); } catch (e) { die(e.message); } // refuses an insecure existing config

const chk = validateWorkspaceTarget(path, loaded.raw);
if (!chk.ok) die(chk.reason + "\n  (workspaces live under ~/bureaus by default; add a \"roots\" entry to " + configPath() + " to allow another location)");

const cfg = loaded.present ? loaded.raw : {};
cfg.workspaces = (cfg.workspaces && typeof cfg.workspaces === "object" && !Array.isArray(cfg.workspaces)) ? cfg.workspaces : {};
cfg.workspaces[id] = { path: chk.dir }; // store the realpath'd, validated directory

const f = configPath();
const dir = dirname(f);
mkdirSync(dir, { recursive: true });
if (safe(() => lstatSync(dir).isSymbolicLink())) die(dir + " is a symlink (refused)");
if (existsSync(f) && safe(() => lstatSync(f).isSymbolicLink())) die(f + " is a symlink (refused)");
// exclusive, no-follow create so a symlink planted at the predictable temp name can't be followed
// and truncated before the chmod; the file is born 0600 and written through the returned fd only.
const tmp = f + ".tmp-" + process.pid;
let fd;
try { fd = openSync(tmp, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW || 0), 0o600); }
catch (e) { die("could not create the temp mapping file (" + (e && e.code || "error") + ")"); }
try { writeSync(fd, JSON.stringify(cfg, null, 2) + "\n"); } finally { closeSync(fd); }
renameSync(tmp, f);
process.stdout.write("✓ paired " + id + " → " + chk.dir + "\n  in " + f + " (0600)\n");
