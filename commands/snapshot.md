---
description: Version the canon with git — pin a named, reproducible snapshot, diff two versions semantically, or render the board as it was at any past commit. Use when running bureau:snapshot, or when the user asks to snapshot / tag / freeze / pin a version of the canon, compare two versions, see what changed, or view the canon as it was at a past point.
argument-hint: "[create <name> [--note \"…\"] | list | diff <A> <B> | at <ref|snapshot>]"
---

# bureau:snapshot — version the canon (git-backed)

A git commit already bundles a consistent `{pages + _log.jsonl + ledgers}`, so the **commit is the
snapshot unit** — no separate store. This command is the thin, human-facing surface over the press's
versioning verbs. It renders, diffs, and pins; it never mutates the canon.

The bundled press is at `${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs`; the workspace is the content
dir named by `<workspace>/bureau.json` (default `canon`, auto-detected). Pass each argument
separately — no shell string interpolation.

## Sub-actions

Parse `$ARGUMENTS`. The first token selects the action; default (no args) is `list`.

### `list` (default)

```
node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" snapshot list --dir <workspace>
```
Print the pinned snapshots — name, short commit, log seq, note. If none, say so and show how to
create one.

### `create <name> [--note "…"]`

```
node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" snapshot create <name> --dir <workspace> [--note "…"]
```
Pins a reproducible `{commit, log-seq, fsck digest}` into `<workspace>/_snapshots.json` (committed).
A snapshot describes a **commit**, so it **refuses a dirty source tree** — if it fails with
"uncommitted changes", tell the user to commit first (the manifest write itself doesn't count).
Validate `<name>` is present and looks like a tag (`[A-Za-z0-9._-]`); the press enforces this too.
After creating, remind the user to **commit `_snapshots.json`** (and push) so the pin persists.

### `diff <A> <B>`

```
node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" diff <A> <B> --dir <workspace>
```
`<A>`/`<B>` may be git refs OR snapshot names. Reports **what changed** from the source of truth: the
decision-log slice (span edits, approvals, confirmations, resolutions) + `_verify.json` artifact
drift (added / removed / changed). It requires B to be an append-only extension of A — if it reports
a divergence, the two versions aren't on the same lineage (check the order).

### `at <ref|snapshot>` — render a past board

```
node "${CLAUDE_PLUGIN_ROOT}/press/bin/gazette.mjs" build --at <ref> --dir <workspace> [--out <dir>]
```
Renders the board **as of** that commit or snapshot into `dist-at-<commit>/` (its own dir — never the
live board). Report the output path so the user can open `dist-at-<commit>/index.html`. The output is
guarded against overwriting live source.

## Rules

1. **Read-only w.r.t. the canon.** This command renders/diffs/pins. It never edits cabinet pages, the
   logbook, or the decision log.
2. **A snapshot is a git pin.** It's only as durable as the commit it names — commit and push
   `_snapshots.json` to preserve it. It is NOT a backup of content (git already is that).
3. **Errors are the press's.** Surface the tool's message verbatim (e.g. "not a valid git ref",
   "uncommitted changes") rather than reinterpreting it.

## Examples

<example>
Context: the user wants to freeze the current reviewed canon before a big refactor.
user: "bureau:snapshot create pre-refactor --note 'canon before the auth rewrite'"
assistant: "Committed working tree, then pinned it: snapshot **pre-refactor** → commit a1b2c3d4, log seq 12. It's recorded in canon/_snapshots.json — commit + push that to preserve the pin. You can now `bureau:snapshot at pre-refactor` any time to render the canon as it is now, or `bureau:snapshot diff pre-refactor HEAD` later to see what changed."
<commentary>A snapshot pins a commit; the manifest is committed so the pin survives.</commentary>
</example>

<example>
Context: the user asks what changed in the canon between two releases.
user: "bureau:snapshot diff v1.0 v1.1"
assistant: "Between v1.0 (seq 20) and v1.1 (seq 27): 7 new log events — 4 span edits (pg-adr-0003 ^decision, …), 2 approvals, 1 conflict resolution — plus artifact drift: [Build command] → package.json changed. That's the semantic changelog from the decision log, not a text diff."
<commentary>diff reads the decision-log slice + ledger drift, reporting decisions and dependency changes, not raw text.</commentary>
</example>

## Scope note

This command ONLY versions the board (render-at / diff / pin). It does not capture, compile, review,
or lint — those move claims through the gate. It is invoked by `bureau:snapshot` and wraps the press's
`build --at`, `diff`, and `snapshot` verbs.
