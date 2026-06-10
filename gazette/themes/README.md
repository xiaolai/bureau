# whiteboard themes

Ready-to-use full themes for the board. Each is a single self-contained CSS file
that re-skins the whole UI (surfaces, text, accents, charts, diagrams) with no
engine changes.

## Use a theme

Copy one into your project root as `theme.css`, then build:

```bash
cp "$(npm root)/@xiaolai/whiteboard/themes/midnight-ink.theme.css" theme.css   # npm
# …or from the plugin cache / repo: copy themes/<name>.theme.css → <project>/theme.css
whiteboard build      # the build reports "theme.css override" and skins dist/
```

The file is loaded after the engine's default theme, so it wins everywhere. It
works fully offline (system fonts, no network) and keeps CJK fallbacks.

## Catalog

| File | Mode | Mood |
|---|---|---|
| `beacon.theme.css` | light | High-contrast / accessibility-first: pure white, near-black ink, saturated blue, true red |
| `clinic.theme.css` | light | Cool, clinical: neutral off-white, slate ink, teal-cyan accent |
| `sepia-archive.theme.css` | light | Warm parchment, brown ink, dusty-teal links, oxblood signal (Georgia body) |
| `midnight-ink.theme.css` | dark | Late-night reading room: blue-charcoal, soft paper text, coral signal |
| `conifer.theme.css` | dark | Forest at dusk: green-charcoal, sand text, mint accent, ember signal |

All five pass **WCAG AA** on every text/UI pair (body, secondary, labels, links,
missing-links, status chips, chart text, count badge) and render with zero console
errors under `file://` with the shipped CSP.

## Make your own

Start from `starter.theme.css` — it stubs every design token and every
literal-color rule at the engine default, so you only change values. The full brief
is in [`dev-docs/theme-spec.md`](../dev-docs/theme-spec.md).
