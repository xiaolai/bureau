// ADR-0003 — the user-local workspace mapping: only the user's ~/.config file may pick a filesystem
// target; a code repo's .bureau-id is a path-free name. These tests drive configPath() via
// XDG_CONFIG_HOME so they never touch the real ~/.config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaceMap, readBureauId, resolveWorkspace } from "../src/core/workspace-map.mjs";

const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
function writeConfig(xdg, obj, mode = 0o600) {
  const dir = join(xdg, "bureau"); mkdirSync(dir, { recursive: true });
  const f = join(dir, "workspaces.json");
  writeFileSync(f, JSON.stringify(obj)); chmodSync(f, mode);
  return f;
}
function makeWorkspace(root, rel = "proj/canon") {
  const dir = join(root, rel); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bureau.json"), "{}"); chmodSync(dir, 0o755);
  return dir;
}
const clean = (...ds) => { for (const d of ds) rmSync(d, { recursive: true, force: true }); delete process.env.XDG_CONFIG_HOME; };

test("workspace-map: absent config → present:false, no throw", () => {
  const xdg = tmp("wm-x-"); process.env.XDG_CONFIG_HOME = xdg;
  try { assert.equal(loadWorkspaceMap().present, false); } finally { clean(xdg); }
});

test("workspace-map: a group/other-writable config is refused", () => {
  const xdg = tmp("wm-x-"); process.env.XDG_CONFIG_HOME = xdg;
  try { writeConfig(xdg, { workspaces: {} }, 0o666); assert.throws(() => loadWorkspaceMap(), /group\/other-writable/); }
  finally { clean(xdg); }
});

test("workspace-map: readBureauId accepts an opaque id, rejects path-shaped ones", () => {
  const cwd = tmp("wm-c-");
  try {
    writeFileSync(join(cwd, ".bureau-id"), "proj-7f3a\n"); assert.equal(readBureauId(cwd), "proj-7f3a");
    writeFileSync(join(cwd, ".bureau-id"), "../evil"); assert.equal(readBureauId(cwd), null);
    writeFileSync(join(cwd, ".bureau-id"), "a/b"); assert.equal(readBureauId(cwd), null);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("workspace-map: no .bureau-id → in-repo mode", () => {
  const cwd = tmp("wm-c-");
  try { assert.equal(resolveWorkspace(cwd).mode, "in-repo"); } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("workspace-map: a present-but-invalid .bureau-id is REJECTED (fail closed, not in-repo)", () => {
  const cwd = tmp("wm-c-");
  try {
    writeFileSync(join(cwd, ".bureau-id"), "../evil"); // path-shaped ⇒ invalid, but the file is present
    const r = resolveWorkspace(cwd);
    assert.equal(r.mode, "rejected");
    assert.match(r.reason, /present but not a valid/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("workspace-map: .bureau-id with no mapping → unpaired (never auto-mapped)", () => {
  const xdg = tmp("wm-x-"), cwd = tmp("wm-c-"); process.env.XDG_CONFIG_HOME = xdg;
  try {
    writeConfig(xdg, { workspaces: {} });
    writeFileSync(join(cwd, ".bureau-id"), "proj-1");
    const r = resolveWorkspace(cwd);
    assert.equal(r.mode, "unpaired"); assert.equal(r.id, "proj-1"); assert.match(r.hint, /bureau:pair proj-1/);
  } finally { clean(xdg, cwd); }
});

test("workspace-map: a validly mapped target resolves to external", () => {
  const xdg = tmp("wm-x-"), cwd = tmp("wm-c-"), root = tmp("wm-r-"); process.env.XDG_CONFIG_HOME = xdg;
  try {
    const ws = makeWorkspace(root);
    writeConfig(xdg, { roots: [root], workspaces: { "proj-1": { path: ws } } });
    writeFileSync(join(cwd, ".bureau-id"), "proj-1");
    const r = resolveWorkspace(cwd);
    assert.equal(r.mode, "external"); assert.equal(r.dir, realpathSync(ws));
  } finally { clean(xdg, cwd, root); }
});

test("workspace-map: a target outside the allowlist roots is rejected", () => {
  const xdg = tmp("wm-x-"), cwd = tmp("wm-c-"), root = tmp("wm-r-"), outside = tmp("wm-o-"); process.env.XDG_CONFIG_HOME = xdg;
  try {
    const ws = makeWorkspace(outside); // physically NOT under `root`
    writeConfig(xdg, { roots: [root], workspaces: { "proj-1": { path: ws } } });
    writeFileSync(join(cwd, ".bureau-id"), "proj-1");
    const r = resolveWorkspace(cwd);
    assert.equal(r.mode, "rejected"); assert.match(r.reason, /outside the allowed roots/);
  } finally { clean(xdg, cwd, root, outside); }
});

test("workspace-map: a target with no bureau.json marker is rejected", () => {
  const xdg = tmp("wm-x-"), cwd = tmp("wm-c-"), root = tmp("wm-r-"); process.env.XDG_CONFIG_HOME = xdg;
  try {
    const ws = join(root, "proj/canon"); mkdirSync(ws, { recursive: true }); chmodSync(ws, 0o755); // no marker
    writeConfig(xdg, { roots: [root], workspaces: { "proj-1": { path: ws } } });
    writeFileSync(join(cwd, ".bureau-id"), "proj-1");
    assert.match(resolveWorkspace(cwd).reason, /no real bureau\.json marker/);
  } finally { clean(xdg, cwd, root); }
});

test("workspace-map: a symlinked target is rejected outright", () => {
  const xdg = tmp("wm-x-"), cwd = tmp("wm-c-"), root = tmp("wm-r-"); process.env.XDG_CONFIG_HOME = xdg;
  try {
    const realWs = makeWorkspace(root, "real/canon");
    const link = join(root, "linked-canon"); symlinkSync(realWs, link);
    writeConfig(xdg, { roots: [root], workspaces: { "proj-1": { path: link } } });
    writeFileSync(join(cwd, ".bureau-id"), "proj-1");
    assert.match(resolveWorkspace(cwd).reason, /symlink/);
  } finally { clean(xdg, cwd, root); }
});
