# bureau — memory trust rule

This repository keeps its durable knowledge in a **bureau** workspace (`{{WORKSPACE}}/`):
topic **cabinet** pages (the canon) plus an append-only **logbook**. The cabinets are repo
memory under a trust gate — honor it whenever you read or write knowledge here.

## Reading the canon

When you use a cabinet page as memory or context, **honor its `status:`**:

- `canonical` — a human approved it → treat as **fact**.
- `verified` — auto-checked against the repo, not yet approved → usable, but reconfirm if it is
  load-bearing.
- `proposed` / `stale` / `contested` — **NOT fact** → verify before relying, and state which
  tier you are leaning on.

Never silently treat a non-`canonical` claim as settled. The tier travels with the claim; if
you cite a cabinet fact, cite its tier too. Prefer `bureau:query`, which enforces this.

## Writing to memory

Never write a new durable claim straight into the canon, and never set `canonical` yourself.
Memory is gated: **capture** (it lands in the low-authority logbook) → **compile** (into cabinet
pages as `proposed`/`verified`) → **review** (a human promotes to `canonical`). The logbook is
append-only — never rewrite a past entry.

When you learn something worth remembering, capture it (`bureau:note` during a session, or
`bureau:file-session` to file it) — do not edit the cabinets directly.
