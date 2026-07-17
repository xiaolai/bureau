// services/theme — ONE token source consumed by every view (PRD architecture §
// "theming as a service"). Build-time renderers and the runtime CSS read the same
// resolved tokens, so no color is ever hardcoded in a view.
//
// These tokens are now the SINGLE source of the default palette: build-runtime
// generates theme.css's `:root` from `emitCssVars(resolveTokens(projectTokens))`,
// so changing a token here recolors docs AND health with no per-view edits. A
// project may override individual tokens via `theme.json`, or the whole stylesheet
// via `theme.css`.

// Semantic default tokens (mirror the shipped template/lib/theme.css :root).
export const DEFAULT_TOKENS = Object.freeze({
  paper: "#f9f7f2", paper2: "#efeae0", sidebar: "#f4f1ea", sidebarEdge: "#e1dacc",
  ink: "#22201b", inkSoft: "#46423a", muted: "#827b6e", faint: "#a8a193",
  line: "#ece7dc", lineStrong: "#ddd6c8",
  accent: "#4a5d6e", accentDeep: "#33424f", rust: "#a8322a", rustDeep: "#7d2620",
  mmdBg: "#fbfaf6",
  // health status tokens (introduced by the health view)
  ok: "#3f7d56", warn: "#a8322a", info: "#4a5d6e",
  // typography + elevation (referenced by theme.css component rules)
  serif: '"Maple Mono CN", "Noto Serif SC", ui-serif, "Songti SC", serif',
  sans: '"Maple Mono CN", "Noto Sans SC", -apple-system, "PingFang SC", sans-serif',
  shadow: "0 1px 2px rgba(40,34,20,.04), 0 8px 28px rgba(40,34,20,.07)",
});

// default ◄ project override ◄ config → frozen token object.
export function resolveTokens(...overrides) {
  const merged = Object.assign({}, DEFAULT_TOKENS, ...overrides.filter(Boolean));
  return Object.freeze(merged);
}

// camelCase + trailing-digit → kebab: accentDeep→accent-deep, paper2→paper-2
// (the digit split keeps the emitted var names aligned with what theme.css reads).
function kebab(k) {
  return k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/([a-z])(\d)/g, "$1-$2");
}

// A token name must be a plain identifier (kebab turns it into `--name`); a value must not carry
// the characters that end a declaration or a rule. Without this, a `theme.json` value like
// `red; } body { display:none` breaks out of `:root` and injects arbitrary CSS into every view,
// and a crafted key does the same. theme.json is author-controlled, so validate before emitting.
const TOKEN_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const CSS_VALUE_BREAKOUT = /[;{}<>\\]|\/\*|\*\/|[\x00-\x1f]/; // decl/rule terminators, comment markers, tag/escape, control chars

// tokens → :root CSS variables. Runtime stylesheets reference var(--token).
export function emitCssVars(tokens) {
  const body = Object.keys(tokens)
    .sort()
    .map((k) => {
      if (!TOKEN_KEY.test(k)) throw new Error('invalid theme token name "' + k + '" (letters and digits only)');
      const v = tokens[k];
      if (typeof v !== "string" || CSS_VALUE_BREAKOUT.test(v)) {
        throw new Error('invalid theme token value for "' + k + '": must be a string with no ; { } < > \\ or comment markers');
      }
      return "  --" + kebab(k) + ": " + v + ";";
    })
    .join("\n");
  return ":root {\n" + body + "\n}\n";
}
