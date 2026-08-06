---
description: Bulk-approve the whole approvable review backlog as canonical, in one confirmation. Shows exactly what would be promoted, confirms in-session, then hands you the single pre-filled `gazette approve --all --by human` line to fire as yourself. The AI never signs `--by human` for you — you run the one line, so the log's human authorship stays true.
argument-hint: "[--workspace <name>]"
---

# bureau:approve-all

Clear the review backlog in one move — without the AI forging your signature. This command finds
every claim awaiting approval, shows you the batch, takes your in-session confirmation, then hands
you a **single ready-to-run line** (path and workspace pre-filled) that you fire yourself with the
`!` prefix. Because *you* run it, the log records `by: human` truthfully.

Why the handoff instead of the AI just doing it: `canonical · by human` is meant to attest that a
human approved. If the AI's process wrote it, that attestation becomes a lie the log can't detect
(BUREAU.md + ADR-0004). So the AI prepares; you commit. It is one keystroke, and it stays honest.

`approve --all` is a **documented weakening** (ADR-0005): it promotes the whole approvable backlog
sight-unseen. Reach for it when you have already vetted the queue elsewhere (for example via
`bureau:codex-review`), not as a substitute for reading load-bearing claims.

## Arguments

| Input | Behavior |
|-------|----------|
| (empty) | Bulk-approve the whole approvable backlog in the default workspace |
| `--workspace <name>` | Target that workspace instead of the `bureau.json` default |

If no bureau workspace exists (`bureau.json` absent and no `canon`/`bureau` directory), stop and
tell the user to run `bureau:init` first. Do nothing else.

## Steps

Follow the protocol in the **approve-all** skill (`skills/approve-all/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `canon`). None → tell the user to run `bureau:init`
   and stop.
2. Build the queue with `gazette review --json --dir <workspace>` and split it: the **approvable**
   items (`approve` / `reapprove`) are what `approve --all` promotes; `confirm-dependencies` /
   `resolve-conflict` / `repair-edge` are **not** covered and stay in the queue. If that command
   errors or returns non-JSON, report the raw error and stop — never guess at the queue contents.
3. If nothing is approvable, report that (plus any excluded items) and stop — never confirm approving
   an empty batch.
4. Show the batch — the count and titles that would become `canonical`, and the excluded items — then
   take an in-session **confirmation** (`AskUserQuestion`: approve all, or cancel).
5. On confirm, hand the human the single pre-filled line to run themselves (never run it yourself):
   `! <abs path to gazette.mjs> approve --all --dir <workspace> --by human`. On cancel, stop —
   nothing is approved.

## Output format

Report, in order:

1. **Workspace** targeted.
2. **Would approve** — the count and titles that `approve --all` would promote to `canonical`.
3. **Not covered** — any `confirm-dependencies` / `resolve-conflict` / `repair-edge` items that stay
   in the queue (approve-all does not touch them).
4. **Your one line** — the exact `! … approve --all --dir <workspace> --by human` command to fire,
   with an alternative for a reviewed, per-page batch (`approve --from`) if you would rather not
   approve sight-unseen.

## Example

```
bureau:approve-all
```

Shows "would approve 6 pages → [titles]; not covered: 1 resolve-conflict", asks you to confirm, then
prints `! node /path/to/press/bin/gazette.mjs approve --all --dir bureau --by human` for you to run —
the AI does not approve on your behalf.
