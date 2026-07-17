// shared/prettify — turn a slug / filename / group-id into a human title:
// "cold_events" → "Cold Events". Used by the model (group display names) and the CLI
// (default doc titles), so both produce identical casing — no second copy (grill L2),
// the same rule as shared/escape, shared/slug, shared/hash.
export function prettify(s) {
  // Unicode-aware word start: uppercase the first LETTER of each word in any script. `\b\w` is
  // ASCII-only — for "élan-vital" it skips the leading "é" and uppercases the inner "l" ("éLan").
  return String(s).replace(/[-_]/g, " ").replace(/(^|\s)(\p{L})/gu, (_, sp, c) => sp + c.toUpperCase());
}
