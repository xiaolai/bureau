// engine/policy — the trust-authority policy (ADR-0001 extension): which AUTHORITY CLASSES may
// satisfy each gated decision. bureau's default is HUMAN-ONLY — a `canonical` page needs a human
// `approve`, an edge cutoff needs a human `confirm-edge`. A runtime workspace opts into accepting a
// deterministic `invariant` authority (or an `llm`), so the automatic invariant gate can stand in
// for the human judge WITHOUT pausing per tick. The policy is a COMMITTED INPUT — it lives in the
// workspace `_config.json` beside `meta`/`groups` — never derived state: like the ledgers, `fsck`
// verifies it is well-formed and ENFORCES it, but never rebuilds it, so the byte-fixpoint is intact.
//
// The `by` field on a decision event is an ACTOR string (a username, "scan", "invariant", …). The
// policy reasons over its AUTHORITY CLASS, not the raw string: the machine authorities are a small
// reserved set; every other value — a person's name, or a missing `by` on a legacy event — is a
// human. That classifier is why this needs ZERO log migration: `by: "xiaolai"` is already a human,
// and an old event with no `by` at all is a human too.
import { existsSync, readFileSync, openSync, closeSync, fstatSync, constants } from "fs";
import { join } from "path";

// The decisions the policy governs, and the authority classes it recognizes. Frozen: these are
// validation constants, and a mutated constant would silently widen every gate in the process.
export const DECISIONS = Object.freeze(["approve", "confirm-edge", "resolve"]);
export const AUTHORITIES = Object.freeze(["human", "scan", "invariant", "llm"]);
const MACHINE = new Set(["scan", "invariant", "llm"]); // reserved names; everything else classifies human

// Deep-freeze a policy: `Object.freeze` alone leaves the authority ARRAYS mutable, so a stray
// `DEFAULT_POLICY.approve.push("llm")` would open the trust gate process-wide with no change to any
// page, log, or `_config.json`. Freeze the arrays too.
function freezePolicy(p) {
  for (const k of Object.keys(p)) if (Array.isArray(p[k])) Object.freeze(p[k]);
  return Object.freeze(p);
}

// bureau's shipped default: the human is the judge on every axis. Applied to an all-human corpus
// (every real `approve`/`confirm-edge` is `by: <person>` → human) the default changes no gate
// outcome and no page's freshness. It is NOT "byte-invisible" in the wider sense: the derived tier
// gained `trustBy`/`trustAuthorized`, and the board gained a Trust facet — both deliberate, and both
// regenerable (the derived cache is gitignored), so no migration is needed.
export const DEFAULT_POLICY = freezePolicy({ approve: ["human"], "confirm-edge": ["human"], resolve: ["human"] });

// Classify an event's `by` into an authority class. Robust to null / non-string / empty (a legacy
// event with no `by`, or a malformed one) → `human`, the historical default. Never throws — the
// classifier sits on the read path and must not be a new failure mode.
//
// NORMALIZED (trim + lowercase) before matching, and that is a SAFETY property, not tidiness: an
// unnormalized compare classified `"Invariant"` / `"invariant "` as **human**, so a machine that
// merely mistyped its own authority silently passed a human-only gate. Normalizing fails that case
// CLOSED (it lands on the machine class it meant), leaving only a deliberate lie — see the threat
// note below.
//
// THREAT MODEL — READ THIS BEFORE TRUSTING A TIER. `by` is a caller ASSERTION, not an authenticated
// identity: the log records what a writer claimed. Any process that can append to the log can write
// `by: "human"`. This policy therefore constrains HONEST actors and mistakes; it is NOT a defence
// against an adversarial writer, and bureau has no authentication boundary to make it one. What the
// log does guarantee is tamper-evidence: entries cannot be rewritten after the fact without `fsck`
// detecting it. Treat `trust_policy` as an integrity control over a cooperating pipeline.
export function authorityClass(by) {
  if (typeof by !== "string") return "human";
  const v = by.trim().toLowerCase();
  if (v === "") return "human";
  return MACHINE.has(v) ? v : "human";
}

// The one predicate the gate and fsck consult: is `by`'s class accepted for `decision`? An unknown
// decision falls back to the human-only default rather than silently accepting anything.
//
// FAIL CLOSED on anything malformed. `allowed` must be a real ARRAY: a raw (unvalidated) policy
// carrying a STRING — `{ approve: "not-llm" }` — would otherwise authorize `by: "llm"` through
// `String.prototype.includes` SUBSTRING matching. Public callers (`computeGate`, `buildDerived`)
// accept a caller-supplied policy object, so this predicate cannot assume it was validated.
export function isAuthorized(policy, decision, by) {
  const raw = policy ? policy[decision] : undefined;
  const cls = authorityClass(by);
  // Two DIFFERENT malformed cases, deliberately handled differently:
  //   · a PRESENT but non-array entry (e.g. the string "not-llm") authorizes NOTHING — it is
  //     corrupt data, and `.includes` on a string would substring-match `llm` straight through.
  //   · an ABSENT/null entry falls back to the human-only DEFAULT — the strictest real policy. It
  //     must NOT authorize nothing: locking out every legitimate human approval over a config typo
  //     is a denial of service, not a safer failure.
  if (raw == null) return Array.isArray(DEFAULT_POLICY[decision]) && DEFAULT_POLICY[decision].includes(cls);
  if (!Array.isArray(raw)) return false;
  return raw.includes(cls);
}

// Validate a user-authored trust_policy block (fail loud at the boundary). An unknown decision key
// and an unknown authority are ERRORS, not silent drops — a typo must never widen or narrow the gate
// unnoticed. A partial policy is completed from DEFAULT_POLICY (naming `approve` only leaves
// confirm-edge/resolve at their human default). Returns a fully-populated, frozen policy.
export function validatePolicy(raw, where = "") {
  // ONLY `undefined` means "absent". An explicit `trust_policy: null` is a malformed authored block —
  // silently treating it as absent would let a restrictive policy be replaced by null and quietly
  // fall back to the default, which is the opposite of the fail-loud posture this validator exists for.
  if (raw === undefined) return DEFAULT_POLICY;
  if (raw === null) throw new Error("trust_policy is null — remove the key to use the default, or give it an object" + where);
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("trust_policy must be a JSON object" + where);
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!DECISIONS.includes(key)) throw new Error('trust_policy: unknown decision "' + key + '" (expected ' + DECISIONS.join("|") + ")" + where);
    const list = raw[key];
    if (!Array.isArray(list) || list.length === 0) throw new Error('trust_policy: "' + key + '" must be a non-empty array of authorities' + where);
    for (const a of list) if (!AUTHORITIES.includes(a)) throw new Error('trust_policy: "' + key + '" has an unknown authority "' + a + '" (expected ' + AUTHORITIES.join("|") + ")" + where);
    out[key] = [...list];
  }
  return freezePolicy({ ...DEFAULT_POLICY, ...out });
}

// Compare an authority list to the default as a SET (order- and duplicate-insensitive), so
// `approve: ["human","human"]` and `["human"]` are correctly the same policy — an exact array
// compare misread the former as "accepts a machine".
const sameAuthorities = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const A = new Set(a), B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

// Does `decision` accept any non-human authority? The per-decision question callers actually need —
// "is this policy non-default" is NOT the same question, and conflating them produced a false
// "`canonical` no longer implies a human vouched" warning for a machine-only `confirm-edge` policy.
export function acceptsMachine(policy, decision) {
  const allowed = (policy && policy[decision]) || DEFAULT_POLICY[decision] || [];
  return Array.isArray(allowed) && allowed.some((a) => a !== "human");
}

export function isDefaultPolicy(policy) {
  if (policy == null) return true;
  return DECISIONS.every((d) => sameAuthorities(policy[d] || DEFAULT_POLICY[d], DEFAULT_POLICY[d]));
}

// A canonical, byte-stable marker of a NON-default policy, for inclusion in derived state so the
// digest attests which policy the rebuild ran under. Returns null for the default, which keeps
// default/all-human derived bytes exactly as they were.
export function policyMarker(policy) {
  if (isDefaultPolicy(policy)) return null;
  return Object.fromEntries(DECISIONS.map((d) => [d, [...new Set(policy[d] || DEFAULT_POLICY[d])].sort()]));
}

// Load + validate the workspace policy from `_config.json`.`trust_policy`. Absent file / absent
// block / symlinked config → the human-only DEFAULT. This is the ONLY reader; the gate and fsck take
// the resolved policy object, so the file is parsed once per run.
export function loadPolicy(workspaceDir) {
  const p = join(workspaceDir, "_config.json");
  if (!existsSync(p)) return DEFAULT_POLICY;
  // Read through ONE descriptor opened O_NOFOLLOW and fstat-verified, so a symlink swapped in between
  // the check and the read cannot redirect us (the lstat-then-read pattern is a TOCTOU). A symlinked
  // or non-regular config yields the default — which is the STRICTEST policy (human-only), so this
  // degrades CLOSED, never open. Matches the ledger module's `hashJailed` posture.
  let text;
  let fd = null;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return DEFAULT_POLICY;
    text = readFileSync(fd, "utf8");
  } catch (e) {
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) return DEFAULT_POLICY; // symlinked config → strictest default
    throw e;
  } finally { if (fd != null) try { closeSync(fd); } catch { /* already closed */ } }
  let cfg;
  try { cfg = JSON.parse(text); }
  catch (e) { throw new Error("_config.json is not valid JSON (" + p + "): " + e.message); }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("_config.json must be a JSON object (" + p + ")");
  return validatePolicy(cfg.trust_policy, " (" + p + ")");
}
