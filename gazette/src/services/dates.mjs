// services/dates — strict, deterministic date parsing (PRD P3; grill H6).
// Accepts only `YYYY-MM-DD`, rejects calendar rollover (2025-02-30 → invalid, not
// silently March 2), parses at UTC midnight so results are timezone-independent.
//
// Returns { present, valid, ts }:
//   absent      → { present:false, valid:false, ts:null }
//   malformed   → { present:true,  valid:false, ts:null }   (a data-quality finding)
//   ok          → { present:true,  valid:true,  ts:<number> }

export function parseDate(s) {
  if (s == null || s === "") return { present: false, valid: false, ts: null };
  const str = String(s).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { present: true, valid: false, ts: null };
  const ts = Date.parse(str + "T00:00:00Z");
  if (Number.isNaN(ts)) return { present: true, valid: false, ts: null };
  // reject rollover: Date.parse("2025-02-30") yields Mar 2; the round-trip won't match.
  if (new Date(ts).toISOString().slice(0, 10) !== str) return { present: true, valid: false, ts: null };
  return { present: true, valid: true, ts };
}

export function isValidDate(s) {
  return parseDate(s).valid;
}
