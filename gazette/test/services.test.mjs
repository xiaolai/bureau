import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveTokens, emitCssVars, DEFAULT_TOKENS } from "../src/services/theme.mjs";
import { escapeHtml, cspMeta } from "../src/services/sanitize.mjs";
import { nfc, compare } from "../src/services/i18n.mjs";

const THEME_CSS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "template", "lib", "theme.css");

test("theme: tokens are the single source — :root is generated, not hardcoded (L1)", () => {
  // every token emits a CSS var
  const css = emitCssVars(DEFAULT_TOKENS);
  for (const key of Object.keys(DEFAULT_TOKENS)) {
    const kebab = key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/([a-z])(\d)/g, "$1-$2");
    assert.match(css, new RegExp("--" + kebab + ":"), "missing var for token " + key);
  }
  // the template theme.css carries the build marker and NO hardcoded :root palette
  const tpl = readFileSync(THEME_CSS, "utf8");
  assert.match(tpl, /\/\*@TOKENS@\*\//, "theme.css missing the @TOKENS@ generation marker");
  assert.doesNotMatch(tpl, /:root\s*\{/, "theme.css still hardcodes a :root palette");
});

test("theme: project override wins, default fills the rest", () => {
  const t = resolveTokens({ accent: "#000000" });
  assert.equal(t.accent, "#000000");
  assert.equal(t.paper, DEFAULT_TOKENS.paper);
});

test("theme: emits sorted :root CSS vars (camelCase → kebab)", () => {
  const css = emitCssVars({ accentDeep: "#111", paper: "#fff" });
  assert.match(css, /--accent-deep: #111;/);
  assert.match(css, /--paper: #fff;/);
  // sorted: accent-deep before paper
  assert.ok(css.indexOf("--accent-deep") < css.indexOf("--paper"));
});

test("sanitize: escapes HTML and emits a CSP", () => {
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.match(cspMeta(), /Content-Security-Policy/);
  assert.match(cspMeta(), /script-src 'self'/);
});

test("i18n: NFC normalizes and collation is stable", () => {
  // U+00C5 vs A + U+030A compose to the same NFC form
  assert.equal(nfc("Å"), nfc("Å"));
  assert.equal(typeof compare("Hero", "Foil"), "number");
});
