// engine/adr — the ADR scaffold: two deterministic pieces the `gazette adr` verb (WI-6) needs so the
// AI never hand-computes numbering or hand-templates a page. PURE. `madrScaffold` authors a `proposed`
// page ONLY — it must NEVER emit a trust marker (the write-gate is non-negotiable, ADR-0004 Decision C).

// Anchored at the START: a page is an ADR by number only if its title/id BEGINS with "ADR-NNNN", so a
// page that merely MENTIONS "ADR-0005" (e.g. "See ADR-0005 for details") is never mistaken for one.
const ADR_RE = /^adr[-\s]?0*(\d+)/i;
const pad = (n) => String(n).padStart(4, "0");

// The next ADR number for a workspace = max(existing ADR numbers) + 1, gap-tolerant, empty ⇒ 1.
// A node counts iff its kind is `adr` or absent AND its title/id begins with the ADR pattern. A node
// with a DIFFERENT kind (e.g. "decision") is never counted, even if titled ADR-000N. Scans the user
// workspace only — the engine's own docs/adr-*.md are a separate namespace.
export function nextAdrNumber(model) {
  const nodes = (model && model.nodes) || {};
  let max = 0;
  for (const n of Object.values(nodes)) {
    if (n.kind != null && n.kind !== "adr") continue; // a kind:decision page titled "ADR-N" is NOT an ADR
    const m = ADR_RE.exec((n.title || "").trim()) || ADR_RE.exec((n.id || "").trim());
    if (m) { const num = parseInt(m[1], 10); if (num > max) max = num; }
  }
  return max + 1;
}

// The full MADR page TEXT (frontmatter + body). `id` is caller-minted (the scaffold does not invent
// identity policy). The number is encoded in the title so `nextAdrNumber` can recover it later. A
// `supersedesTitle` yields ONE single-line `supersedes: "[[T]]"` typed edge (WI-1 parses it); absent ⇒
// no key. Deterministic — no clock/randomness (date is a parameter).
export function madrScaffold({ number, title, id, date, supersedesTitle } = {}) {
  const heading = "ADR-" + pad(number) + " — " + title;
  const fm = [
    "---",
    "id: " + id,
    "title: " + heading,
    "status: proposed",
    "kind: adr",
    ...(date ? ["updated: " + date] : []),
    ...(supersedesTitle ? ['supersedes: "[[' + supersedesTitle + ']]"'] : []),
    "---",
  ];
  const body = [
    "# " + heading,
    "",
    "## Context and Problem Statement",
    "",
    "<!-- What is the issue this decision resolves, and why now? A few sentences. -->",
    "",
    "## Decision Drivers",
    "",
    "<!-- - a force / concern / constraint that shapes the decision -->",
    "",
    "## Considered Options",
    "",
    "<!-- - Option A",
    "     - Option B -->",
    "",
    "## Decision Outcome",
    "",
    'Chosen option: **"<option>"**, because <justification>.',
    "",
    "## Consequences",
    "",
    "<!-- - Good, because … / Bad, because … / Neutral, because … -->",
    "",
    "## Confirmation",
    "",
    "How this decision is verified to hold. Fingerprint the confirming artifact so that when it drifts,",
    "this ADR is re-flagged for review:",
    "",
    "```",
    'gazette ledger verify --dir <workspace> --page "' + heading + '" --artifact <path> --claim "<what it confirms>"',
    "```",
    "",
  ];
  return fm.join("\n") + "\n" + body.join("\n") + "\n";
}
