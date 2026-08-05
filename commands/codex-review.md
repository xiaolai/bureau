---
description: Let Codex (via cc-suite) deliberate over the bureau review queue as your representative — it reads each unapproved claim and recommends approve or hold, then either hands you the exact approve command (advisor, default) or, only where the workspace opted in, commits under its own `codex` authority (delegate).
argument-hint: "[--delegate] [--next <N>] [--workspace <name>]"
---

# bureau:codex-review

You often trust Codex's judgment over your own snap call on a review decision, and cc-suite makes
Codex reachable in this repo. This command puts Codex to work as your **representative** over the
bureau review queue — without weakening the human gate.

It runs in one of two modes:

- **Advisor (default).** Codex reads every unapproved claim and its bytes and recommends `approve`
  or `hold`. The command writes a `--from` manifest of Codex's approvals and hands you the exact
  `gazette approve --from <file> --by human` command. **You** sign — the gate stays human. This is
  "Codex advises, you commit."
- **Delegate (`--delegate`).** Only where the workspace's `trust_policy.approve` accepts the `codex`
  authority does the command commit the manifest itself as `--by codex`. `canonical · by codex` is
  pipeline-trust, **not** human confidence — a machine reviewed it, and the board says so.

The command **never** asserts `--by human`, never approves an item that retires another decision
(a `supersedes` warning routes to you), and never auto-approves a contested or broken-edge item.

## Arguments

| Input | Behavior |
|-------|----------|
| (empty) | Advisor mode over the whole approvable queue |
| `--delegate` | Delegate mode — commit `--by codex` IF the policy accepts it, else refuse with the opt-in |
| `--next <N>` | Only deliberate over the first `N` queue items (a positive integer) |
| `--workspace <name>` | Target that workspace instead of the `bureau.json` default |

If no bureau workspace exists (`bureau.json` absent and no `canon`/`bureau` directory), stop and
tell the user to run `bureau:init` first. Do nothing else.

## Steps

Follow the protocol in the **codex-review** skill (`skills/codex-review/SKILL.md`). In short:

1. Locate the workspace (`bureau.json`; default `canon`). None → tell the user to run `bureau:init`
   and stop.
2. Build the machine-readable queue: `gazette review --json --dir <workspace>` (add `--next <N>`
   when passed). Keep only `approve` / `reapprove` items — they carry the `digest` a manifest needs.
3. Exclude from Codex entirely: any item that **retires another decision** (a `supersedes` field),
   plus every `confirm-dependencies` / `resolve-conflict` / `repair-edge` item. List them as "left
   for you" — they need a human decision or a source edit, never a machine approval.
4. For each remaining page, send its bytes to Codex (`codex exec -s read-only`) as **untrusted
   data** and collect a strict-JSON verdict (`approve` or `hold`, with a one-line reason and the
   digest it judged).
5. Re-check the queue, then build the manifest `{approve:[{page,digest}]}` from only the pages Codex
   approved whose digest is unchanged. Write it plus an evidence file under the workspace.
6. **Advisor:** print the verdict table and the exact `gazette approve --from <file> --by human`
   command, then stop. **Delegate:** verify the policy accepts `codex`; if so run
   `gazette approve --from <file> --by codex` and report the batch; if not, refuse and print the
   one-line `_config.json` opt-in.

## Output format

Report, in this order:

1. **Mode** — advisor or delegate — and the workspace.
2. **Verdict table** — one row per deliberated page: page · Codex verdict (`approve`/`hold`) · the
   one-line reason.
3. **Left for you** — items skipped as human-only (retirements, conflicts, broken edges, confirms).
4. **Next action** — the exact `gazette approve --from <file> --by human` command (advisor), or the
   committed batch id and evidence-file path (delegate), or the `trust_policy` opt-in (delegate when
   the policy does not yet accept `codex`).

## Example

```
bureau:codex-review --next 5
```

Codex deliberates over the first five approvable claims and prints, for each, `approve` or `hold`
with its reason; the command writes `bureau/_codex-review.json` and hands you
`gazette approve --from bureau/_codex-review.json --dir bureau --by human` to run yourself.
