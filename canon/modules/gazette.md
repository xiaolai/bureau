---
title: gazette (the bundled dashboard)
updated: 2026-06-11
status: verified
---

# gazette (the bundled dashboard)

gazette is bureau's renderer, **owned in-tree** (formerly the standalone `whiteboard` plugin,
now retired). It ships as a **single self-contained esbuild bundle** — `gazette/bin/gazette.mjs`
with markdown-it / node-html-parser / sanitize-html inlined (a `createRequire` banner lets
postcss's dynamic `require` resolve) — so it runs on Node ≥18 with **no `node_modules`** and no
separate install. `bureau:inspect` runs it directly; `scripts/build-gazette.mjs` rebuilds it
from `gazette/src`.

**Verified.** `gazette/bin/gazette.mjs` exists and builds a workspace with no node_modules;
gazette's own 160-test suite is in-tree · checked 2026-06-11.

**Sources.** [[session gazette · 2026-06-11]]
