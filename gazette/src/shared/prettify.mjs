// shared/prettify — turn a slug / filename / group-id into a human title:
// "cold_events" → "Cold Events". Used by the model (group display names) and the CLI
// (default doc titles), so both produce identical casing — no second copy (grill L2),
// the same rule as shared/escape, shared/slug, shared/hash.
export function prettify(s) {
  return String(s).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
