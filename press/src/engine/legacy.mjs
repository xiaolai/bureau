// engine/legacy — the LEGACY-CANONICAL grandfather manifest (ADR-0004, Phase 6). A committed INPUT
// (`<workspace>/_legacy-canonical.json`) pinning `{uid: page_digest}` for pages that are effective-
// canonical but NOT content-bound: an authored `canonical` with no approve event, or a real approve
// event that predates content-binding (no `hash`). It grandfathers each as `legacy-canonical` —
// honestly WEAKER than `approved` ("grandfathered, not review-backed") — converting a BLOCKING
// `unbacked-canonical` into an ADVISORY finding, and it is VOIDED the moment the page's digest no
// longer matches the pin (a meaningful edit drops the grandfather). It NEVER forges an approve event
// and never asserts a human authority; a real content-bound approval supersedes it, and the pin is
// removed when it does. Human-initiated + committed (reviewed in the diff) — the AI builds the
// mechanism and may generate the pins, but the tier never claims a human vouched for the content.
import { existsSync, openSync, closeSync, fstatSync, readFileSync, constants } from "fs";
import { join } from "path";
import { projectDecisions } from "./state.mjs";

export const LEGACY_BASENAME = "_legacy-canonical.json";
export function legacyPath(dir) { return join(dir, LEGACY_BASENAME); }

// Load + validate the manifest. Absent / symlinked (TOCTOU-safe, O_NOFOLLOW) / non-object → EMPTY:
// fail closed, so a bad manifest grandfathers nothing and pages fall back to their real finding.
export function loadLegacy(dir) {
  const p = legacyPath(dir);
  const empty = () => ({ schema: 1, pins: Object.create(null) });
  if (!existsSync(p)) return empty();
  let fd = null, text;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return empty();
    text = readFileSync(fd, "utf8");
  } catch (e) {
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) return empty();
    throw e;
  } finally { if (fd != null) try { closeSync(fd); } catch { /* already closed */ } }
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new Error(LEGACY_BASENAME + " is not valid JSON (" + p + "): " + e.message); }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(LEGACY_BASENAME + " must be a JSON object (" + p + ")");
  const pins = Object.create(null);
  const raw = cfg.pins && typeof cfg.pins === "object" && !Array.isArray(cfg.pins) ? cfg.pins : {};
  for (const k of Object.keys(raw)) if (typeof raw[k] === "string" && raw[k]) pins[k] = raw[k];
  return { schema: 1, pins };
}

// Is `uid` grandfathered at its CURRENT digest? (A mismatch means the page changed → not grandfathered.)
export function isGrandfathered(legacy, uid, digest) {
  return !!legacy && !!legacy.pins && digest != null && Object.prototype.hasOwnProperty.call(legacy.pins, uid) && legacy.pins[uid] === digest;
}

// The candidate set for a migration: pages that are effective-canonical but NOT already content-bound
// by a hashed approval — i.e. exactly the pages that would otherwise draw `unbacked-canonical` /
// `unbound-approval`. Returns `{ uid: currentDigest }` (skipping any page whose digest can't be
// computed). Ignores the existing manifest — this is what the migrate command pins. `digestFor(uid)`
// supplies the page's current review digest.
export function legacyCandidates({ model, events, policy, digestFor }) {
  const { approved, approvedHash } = projectDecisions(events, policy);
  const out = Object.create(null);
  for (const n of Object.values(model.nodes)) {
    const effectiveCanonical = approved.has(n.uid) || (n.trust || n.status) === "canonical";
    if (!effectiveCanonical) continue;
    if (approved.has(n.uid) && approvedHash.get(n.uid) != null) continue; // already content-bound
    const d = digestFor(n.uid);
    if (d != null) out[n.uid] = d;
  }
  return out;
}
