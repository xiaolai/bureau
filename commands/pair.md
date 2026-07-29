---
description: Pair this repo's external bureau workspace (its .bureau-id) to a local path on this machine.
argument-hint: "[<workspace-path>]"
---

# bureau:pair

Bind this repo's **external** bureau workspace to where it lives on **this** machine (ADR-0003).

An external workspace keeps the canon out of a public code repo: the code repo commits only a
path-free `.bureau-id`, and the actual workspace lives under `~/bureaus/<proj>/canon` (its own git
repo, privately backed up). The mapping from that opaque id to a filesystem path is **user-local**
(`~/.config/bureau/workspaces.json`, `0600`) — never committed — so a cloned public repo can't steer
writes anywhere. On a fresh machine you clone/restore the workspace, then run this once to pair it.

## When you need it

- A `bureau:*` command or the capture hook reported the `.bureau-id` is **not paired** on this machine.
- You just cloned/restored the workspace to `~/bureaus/<proj>` and want capture + the board to find it.

## Steps

1. **Read the id.** Read `./.bureau-id` in the current repo (a single opaque token). If it is absent,
   this repo is not an external workspace — stop and report (use `bureau:init --external` to create one).

2. **Locate the workspace.** Determine the workspace path on this machine. If the user passed a path
   in `$ARGUMENTS`, use it; otherwise the convention is `~/bureaus/<name>/canon`. The path must
   already exist as a real workspace (carry a `bureau.json` marker); if it is not yet present, tell the
   user to clone/restore their `~/bureaus/<name>` backup first, then re-run.

3. **Pair it.** Run the helper — it applies every security control (real, non-symlink target under an
   allowed root, `bureau.json` marker, owned by you, not group/other-writable) and writes the mapping
   `0600`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.mjs" "<id-from-.bureau-id>" "<workspace-path>"
   ```

   Never hand-edit `~/.config/bureau/workspaces.json` — the helper is the only safe writer, and it
   refuses an insecure config or a target outside the allowed roots (`~/bureaus` by default; add a
   `"roots"` entry to the config to allow another location).

4. **Verify.** Run `node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" fsck --dir <workspace-path>`
   (or `bureau:inspect`) and confirm it resolves. Report the paired id → path.

## Notes

- Pairing is per-machine and explicit — bureau never auto-maps an unknown id.
- The mapping stores a path only; the `.bureau-id` in the repo stays path-free.
