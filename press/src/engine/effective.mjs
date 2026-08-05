// The reader-facing projection of content-bound trust (ADR-0004 Decision C).
//
// Authoritative trust is a PROJECTION of the decision log, not authored/stamped frontmatter — and
// under content-binding (ADR-0004) a logged approval only counts while its `hash` still matches the
// page's current bytes. So a reader that keys off frontmatter `status:` (the chamber's review queue,
// the board tier) would keep showing a page as `canonical` after it was edited past its approval.
//
// This helper gives every reader ONE answer, derived from `fsck` (read-only, `write:false`) so no
// projection logic is duplicated and readers can never disagree with the gate:
//   • `canonical`  — uids that are EFFECTIVELY canonical: the derived tier projects `canonical` AND
//                    the gate does not flag the backing as stale / unbacked / unauthorized.
//   • `needsReview` — uids that LOOK canonical (by intent or a lapsed stamp) but are NOT backed right
//                    now: a stale approval (edited after review), an unbacked authored `canonical`, or
//                    one an unaccepted authority "approved". These must RE-ENTER the review queue.
// A grandfathered `legacy-canonical` page draws no such flag, so it stays in `canonical` (accepted).
//
// `docsDir` OR a pre-loaded `{corpus, events, policy}` may be passed through to `fsck`. Never writes.
import { fsck } from "./fsck.mjs";

const NOT_BACKED = new Set(["stale-approval", "unbacked-canonical", "unauthorized-canonical"]);

export function effectiveReview({ docsDir, corpus, events, policy } = {}) {
  const report = fsck({ docsDir, corpus, events, policy, write: false });
  const needsReview = new Set();
  for (const f of report.findings) if (NOT_BACKED.has(f.kind) && f.uid != null) needsReview.add(f.uid);
  // ADR-0005 Decision D: a page in an UNRESOLVED contradiction is not fact even if approved — approving
  // both sides of a `contradicts` never settles it. Exclude a `contested` page from `canonical` (it is a
  // resolve-conflict work item) and surface it as needing attention.
  for (const d of report.derived.decided) if (d.conflict === "contested") needsReview.add(d.uid);
  // ADR-0006: an effectively-superseded page is settled history — excluded from the `canonical` fact
  // set but, UNLIKE `contested`, NOT added to `needsReview` (it is not pending work). The positive
  // `superseded` surface lets `query`/`recall` say "superseded by M" instead of silently omitting it.
  const supersededMap = report.superseded || new Map();
  const supersededUids = new Set(supersededMap.keys());
  const superseded = [...supersededUids].sort((a, b) => (a < b ? -1 : 1)).map((uid) => ({ uid, status: "superseded", supersededBy: supersededMap.get(uid) }));
  const canonical = new Set();
  for (const d of report.derived.decided) if (d.trust === "canonical" && !needsReview.has(d.uid) && !supersededUids.has(d.uid)) canonical.add(d.uid);
  return { canonical, needsReview, superseded, report };
}
