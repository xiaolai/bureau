// render/health-report — render the health layer into (a) a board doc (HTML) and
// (b) a CLI text summary. The board "view" is a generated doc, like the timeline.
// [[id]] links are resolved + the HTML sanitized by build.mjs before shipping.
import { healthTotal } from "../derive/health.mjs";
import { escapeHtml, escapeAttr, stripControl } from "../shared/escape.mjs";

// A doc title is untrusted. Emitting `[[<title>]]` put it into the page's HTML RAW — a title
// like `<img src=x onerror=…>` landed as a live tag and only the downstream sanitizer's
// allowlist stood between it and the reader. Emit a resolved-at-build `data-wiki` anchor
// instead, with the title escaped in both the attribute and the link text. build.mjs indexes
// data-wiki references exactly like [[..]], so backlinks are unchanged.
const wl = (id) => '<a data-wiki="' + escapeAttr(String(id == null ? "" : id)) + '">' + escapeHtml(String(id == null ? "" : id)) + "</a>";
const esc = (s) => escapeHtml(String(s == null ? "" : s));

// ── The unified live ENGINE view ─────────────────────────────────────────────────────────────────
// The three dynamic, dependency-aware signals the live board exists to show, under one banner and
// distinct from the structural checks below: page↔page FRESHNESS (a page on a changed upstream span),
// claim↔file ARTIFACT currency (a verified file that drifted), and the CONVERGENCE trend (is the canon
// settling or thrashing?). Each keeps its own honest scope. Rendered first — it is the live state.

// (1) dependency freshness — the recursion-engine gate against the working tree. Kept named "Drift ·
// engine" (established label); distinct from the coarse timestamp `Stale` lane in the structural block.
function renderFreshness(fresh) {
  if (!fresh) return "";
  if (fresh.integrity) return '<h3>Drift · engine</h3><blockquote><p>⚠ The decision log failed its integrity check' +
    (fresh.integrity.reason ? " (" + esc(fresh.integrity.reason) + ")" : "") + " — freshness badges are suppressed. Run <code>gazette fsck</code>.</p></blockquote>";
  const { counts, drift, pending } = fresh;
  const total = counts.needsReview + counts.stale + counts.modified;
  if (!total) return '<h3>Drift · engine</h3><blockquote><p>✅ Every page is current — no page sits on a changed upstream, and nothing is unscanned.</p></blockquote>';
  let s = "<h3>Drift · engine · " + total + "</h3><blockquote><p>Dependency-aware freshness (the deterministic gate, not the timestamp heuristic): " +
    counts.needsReview + " need review · " + counts.stale + " stale · " + counts.modified + " modified" +
    (pending ? " · " + pending + " uncommitted span change" + (pending === 1 ? "" : "s") + " (run <code>gazette scan</code> to record)" : "") + ".</p></blockquote>";
  if (drift.length) {
    s += '<table class="wb-table"><thead><tr><th>Page</th><th>Rests on</th><th>Why</th></tr></thead><tbody>' +
      drift.map((d) => "<tr><td>" + wl(d.page) + "</td><td>" + wl(d.on) + (d.span ? " <code>" + esc(d.span) + "</code>" : "") +
        '</td><td><span class="meta-chip meta-chip--fresh-' + esc(d.level) + '">' + esc(d.level) + "</span> " + esc(d.reason) + "</td></tr>").join("") +
      "</tbody></table>";
  }
  return s;
}

// (2) artifact currency — the `_verify.json` ledger re-hashed against the working tree. This is the
// one place the canon touches the real repository: a claim verified against a file that has since
// changed is silently rotten, and only this surfaces it in the board.
function renderArtifacts(arts) {
  if (!arts) return "";
  if (arts.error) return '<h3>Artifacts · currency</h3><blockquote><p>⚠ The artifact ledger <code>_verify.json</code> is malformed (' + esc(arts.error) + ") — run <code>gazette fsck</code>.</p></blockquote>";
  const { counts, drift } = arts;
  if (!counts.pages) return '<h3>Artifacts · currency</h3><blockquote><p>No artifacts fingerprinted yet — record one with <code>gazette ledger verify --page "…" --artifact &lt;path&gt;</code> so a claim tracks the file it was checked against.</p></blockquote>';
  if (!counts.drifted) return "<h3>Artifacts · currency</h3><blockquote><p>✅ Every fingerprinted artifact is current — all " + counts.current +
    " check(s) across " + counts.pages + " page(s) still match the file they were verified against.</p></blockquote>";
  let s = "<h3>Artifacts · currency · " + counts.drifted + "</h3><blockquote><p>" + counts.drifted + " artifact(s) DRIFTED (the file changed since the claim was verified) · " +
    counts.current + " still current — a drifted artifact means a <code>verified</code>/<code>canonical</code> claim may no longer hold. Re-verify with <code>gazette ledger verify</code>.</p></blockquote>";
  s += '<table class="wb-table"><thead><tr><th>Page</th><th>Artifact</th><th>State</th></tr></thead><tbody>' +
    drift.map((d) => "<tr><td>" + wl(d.page) + "</td><td><code>" + esc(d.artifact) + "</code></td><td>" +
      '<span class="meta-chip meta-chip--artifacts-drifted">DRIFTED</span> ' + (d.now === null ? "missing or unreadable" : "hash changed") + "</td></tr>").join("") +
    "</tbody></table>";
  return s;
}

// (3) convergence — a deterministic replay of the decision log (telemetry §4.14). Is the canon
// settling (queue drains, repeated firings fall) or thrashing? The verdict is ALWAYS printed beside
// the raw numbers, never alone.
function renderConvergence(converge) {
  if (!converge) return "";
  if (!converge.observations.length) return "<h3>Convergence</h3><blockquote><p>No history yet — edit a claim, <code>gazette scan</code>, then confirm it in review to build a trend.</p></blockquote>";
  const s = converge.stabilization, cur = converge.current;
  const pct = (r) => (r == null ? "n/a" : (r * 100).toFixed(1) + "%");
  return "<h3>Convergence · " + esc(s.verdict) + '</h3><blockquote><p><span class="meta-chip meta-chip--converge-' + esc(s.verdict) + '">' + esc(s.verdict) +
    "</span> review queue depth " + cur.queueDepth + " (peak " + converge.peakQueueDepth + ") · " + converge.repeatedFirings + " page(s) re-fired (max " + converge.maxFirings +
    "×) · per-run work mean " + converge.perRunWork.mean.toFixed(1) + " · cutoff " + pct(cur.cutoffRatio) + " beside " + cur.tracked +
    " tracked edge(s). Convergence is eventual stabilization under bounded work, not a shrinking set.</p></blockquote>";
}

// (4) trust authority — who backs each `canonical` page under the workspace trust-authority policy.
// The gate says a page is fresh; the tier says it is approved; THIS says by whom. When a workspace
// accepts a non-human authority (a runtime's automatic `invariant` gate), `canonical` no longer means
// "a human vouched" — so the board must show the authority beside the tier, and flag any canonical the
// policy does not accept. All-human + human-only policy (the bureau default) → a clean one-liner.
function renderTrust(authority) {
  if (!authority) return "";
  const { accept = ["human"], canonical = [], machineBacked = [], unauthorized = [], unbacked = [] } = authority;
  if (!canonical.length) return ""; // nothing canonical yet — no authority to report
  const accepts = "accepted authorities: <code>" + esc(accept.join(", ")) + "</code>";

  // The clean branch asserts "a human approved every canonical page" — so it must be proven by EVERY
  // row, never inferred from the auxiliary arrays being empty. An UNBACKED canonical (no approve
  // event at all) has `by: null` and sits in neither machineBacked nor unauthorized; inferring from
  // those arrays printed a green human certification for a page nobody approved.
  const allHumanApproved = canonical.every((r) => r.by === "human" && r.authorized);
  if (allHumanApproved)
    return "<h3>Trust · authority</h3><blockquote><p>✅ All " + canonical.length + " <code>canonical</code> page(s) were approved by a <strong>human</strong> (" + accepts + ").</p></blockquote>";

  // Every row that is not a clean human approval, deduplicated by page — a mixed corpus must not hide
  // accepted machine-backed pages behind the unauthorized ones.
  const rows = canonical.filter((r) => !(r.by === "human" && r.authorized));
  const problems = unauthorized.length + unbacked.length;
  const bits = [];
  if (machineBacked.length) bits.push(machineBacked.length + " approved by a NON-human authority — <code>canonical</code> here does not imply a human vouched");
  // reported INDEPENDENTLY of machineBacked: under a machine-only policy a rejected approval can be a HUMAN one.
  if (unauthorized.length) bits.push("<strong>" + unauthorized.length + " approved by an authority this workspace does NOT accept</strong>");
  if (unbacked.length) bits.push("<strong>" + unbacked.length + " with no approval at all (unbacked)</strong>");

  let s = "<h3>Trust · authority · " + (problems || machineBacked.length) + "</h3><blockquote><p>Of " + canonical.length +
    " <code>canonical</code> page(s): " + bits.join(" · ") + ". " +
    (problems ? "Run <code>gazette fsck</code> — these are blocking findings. " : "") + accepts + ".</p></blockquote>";
  s += '<table class="wb-table"><thead><tr><th>Page</th><th>Approved by</th><th>State</th></tr></thead><tbody>' +
    rows.map((r) => {
      const state = r.authorized ? "accepted"
        : r.by == null ? '<span class="meta-chip meta-chip--fresh-stale">unbacked</span>'
        : '<span class="meta-chip meta-chip--fresh-stale">unauthorized</span>';
      return "<tr><td>" + wl(r.page) + "</td><td>" + (r.by == null ? "<em>no approval</em>" : "<code>" + esc(r.by) + "</code>") + "</td><td>" + state + "</td></tr>";
    }).join("") +
    "</tbody></table>";
  return s;
}

// The Engine banner + its facets, one coherent live view.
function renderEngine(fresh, arts, converge) {
  const authority = fresh && fresh.authority;
  const facets = renderFreshness(fresh) + renderArtifacts(arts) + renderConvergence(converge) + renderTrust(authority);
  if (!facets) return "";
  const bits = [];
  if (fresh && fresh.integrity) bits.push("⚠ decision-log integrity FAILED");
  else if (fresh) { const t = fresh.counts.needsReview + fresh.counts.stale + fresh.counts.modified; bits.push(t ? t + " page(s) drifted" : "every page current"); }
  if (arts && !arts.error) bits.push(arts.counts.drifted ? arts.counts.drifted + " artifact(s) drifted" : (arts.counts.pages ? "artifacts current" : "no artifacts fingerprinted"));
  if (converge && converge.observations.length) bits.push("canon " + converge.stabilization.verdict);
  // each signal is independent — a rejected HUMAN approval (machine-only policy) or an unbacked
  // canonical must reach the banner even when nothing is machine-backed.
  if (authority) {
    const bad = (authority.unauthorized || []).length + (authority.unbacked || []).length;
    if (authority.machineBacked.length) bits.push(authority.machineBacked.length + " canonical machine-backed");
    if (bad) bits.push("⚠ " + bad + " canonical not backed by an accepted authority");
  }
  return "<h2>Engine · live state</h2><blockquote><p>The recursion engine's live, dependency-aware view — <em>distinct</em> from the deterministic structural checks below." +
    (bits.length ? " <strong>" + esc(bits.join(" · ")) + ".</strong>" : "") + "</p></blockquote>" + facets;
}

export function renderHealthHtml(health, fresh = null, arts = null, converge = null) {
  const c = health.counts;
  const clean = healthTotal(health) === 0;
  let b = '<article data-generated="health"><h1>Health</h1>';
  b += "<blockquote><p>Automatic, deterministic check (no LLM) of the read-only projection — it watches for what the writing side hasn't caught up on.";
  if (health.now) b += "<br>Baseline <code>" + esc(health.now) + "</code>, stale window " + health.staleWindowDays + " days.";
  b += "</p></blockquote>";
  b += renderEngine(fresh, arts, converge); // the unified live Engine view, before the structural counts

  const rows = [
    ["Dangling links (likely rename/typo)", c.dangling],
    ["Orphans (no links in or out)", c.orphan],
    ["Contradictions (typed <code>contradicts</code>)", c.contradiction],
    ["Invalid dates (bad <code>updated</code>)", c.invalidDate],
    ["<code>_types</code> schema violations", c.schema],
    ["Ledger drift (declared ≠ actual)", c.drift],
    ["Stale — timestamp heuristic (neighbors moved, this didn't)", c.stale],
    ["Unsourced (a claim with no provenance)", c.unsourced],
  ];
  b += '<table class="wb-table"><thead><tr><th>Check</th><th class="num">Count</th></tr></thead><tbody>' +
    rows.map(([k, v]) => "<tr><td>" + k + '</td><td class="num">' + v + "</td></tr>").join("") +
    "</tbody></table>";

  // "clean" is STRUCTURAL only — the Drift section above carries dependency-aware freshness, which
  // can flag needs-review/stale/integrity even when the structural checks pass. Qualify accordingly.
  if (clean) return b + "<blockquote><p>✅ No <em>structural</em> findings — the knowledge base is structurally consistent." +
    (fresh || arts || converge ? " (Live dependency freshness, artifact currency, and convergence are in the <strong>Engine</strong> view above.)" : "") + "</p></blockquote></article>";

  const section = (title, n, note, inner) =>
    "<h2>" + esc(title) + " · " + n + "</h2><blockquote><p>" + note + "</p></blockquote>" + inner;
  const tbl = (head, body) => '<table class="wb-table"><thead><tr>' + head.map((h) => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" + body + "</tbody></table>";

  if (c.dangling) {
    b += section("Dangling links", c.dangling, "A <code>[[target]]</code> that resolves to no document — usually a leftover after a rename, or a typo.",
      tbl(["From", "Target (missing)", "Relation"], health.dangling.map((d) => "<tr><td>" + wl(d.source) + "</td><td>" + esc(d.target) + "</td><td>" + esc(d.edgeType || "body") + "</td></tr>").join("")));
  }
  if (c.orphan) {
    b += section("Orphans", c.orphan, "Nothing links in and it links out to nothing — possibly forgotten or not yet wired in.",
      "<ul>" + health.orphan.map((o) => "<li>" + wl(o.node) + "</li>").join("") + "</ul>");
  }
  if (c.contradiction) {
    b += section("Contradictions", c.contradiction, "An explicit <code>contradicts:</code> relation — needs an author's decision.",
      "<ul>" + health.contradiction.map((x) => "<li>" + wl(x.a) + " ⟷ " + wl(x.b) + "</li>").join("") + "</ul>");
  }
  if (c.invalidDate) {
    b += section("Invalid dates", c.invalidDate, "<code>updated:</code> is not a valid <code>YYYY-MM-DD</code> — the staleness check skips this doc.",
      tbl(["Document", "updated (invalid)"], health.invalidDate.map((d) => "<tr><td>" + wl(d.node) + "</td><td><code>" + esc(d.updated) + "</code></td></tr>").join("")));
  }
  if (c.schema) {
    const K = { unknownEdge: "undeclared relation", unknownField: "undeclared field", missingRequired: "missing required key", multiSingle: "single-valued field given a list" };
    b += section("_types schema violations", c.schema, "A document doesn't match the schema declared for its group in <code>docs/_types/</code>.",
      tbl(["Document", "Problem", "Key"], health.schema.map((s) => "<tr><td>" + wl(s.node) + "</td><td>" + esc(K[s.kind] || s.kind) + "</td><td><code>" + esc(s.key) + "</code></td></tr>").join("")));
  }
  if (c.drift) {
    b += section("Ledger drift", c.drift, "The doc count declared in <code>_config.json</code> doesn't match what's on disk.",
      "<ul>" + health.drift.map((d) => "<li>declared " + d.declared + ", actual " + d.actual + "</li>").join("") + "</ul>");
  }
  if (c.stale) {
    b += section("Stale (timestamp heuristic)", c.stale, "A coarse signal: this page's <code>updated:</code> is older than a doc it links to. For <em>precise</em>, dependency-aware freshness (which upstream claim actually changed), see the <strong>Drift · engine</strong> section above — that's the recursion engine; this lane is the fallback for docs that declare no <code>rests_on</code> edges.",
      tbl(["Document", "Updated", "Newer neighbor"], health.stale.map((s) => "<tr><td>" + wl(s.node) + "</td><td>" + esc(s.updated) + "</td><td>" + wl(s.newerNeighbor) + "</td></tr>").join("")));
  }
  if (c.unsourced) {
    b += section("Unsourced", c.unsourced, "This page states a claim (it carries a trust tier) but links back to nothing that justifies it. Add a body <code>**Sources.**</code> line linking the source document the claim came from. Provenance must be a <code>[[wiki-link]]</code> — a plain string is prose, not a link.",
      tbl(["Document", "Tier"], health.unsourced.map((u) => "<tr><td>" + wl(u.node) + "</td><td><code>" + esc(u.status) + "</code></td></tr>").join("")));
  }
  return b + "</article>";
}

// A doc title is untrusted text. In the TEXT report it is concatenated straight into lines the
// reader trusts, so a control character (newline, CR, ANSI escape) could forge output — e.g. a
// title carrying "\n  dangling links : 0" fakes a clean bill in the terminal or in CI logs.
// Collapse every control char to a space; the HTML path is escaped separately by esc().
const plain = stripControl;

export function renderHealthText(health) {
  const c = health.counts;
  const lines = [
    "gazette health" + (health.now ? " (now=" + health.now + ")" : ""),
    "  dangling links : " + c.dangling,
    "  orphans        : " + c.orphan,
    "  contradictions : " + c.contradiction,
    "  invalid dates  : " + c.invalidDate,
    "  schema viol.   : " + c.schema,
    "  ledger drift   : " + c.drift,
    "  stale          : " + c.stale,
    "  unsourced      : " + c.unsourced,
  ];
  for (const d of health.dangling) lines.push("  x dangling  " + plain(d.source) + " -> " + plain(d.target) + " (" + plain(d.edgeType || "body") + ")");
  for (const o of health.orphan) lines.push("  o orphan    " + plain(o.node));
  for (const x of health.contradiction) lines.push("  ! contra    " + plain(x.a) + " <> " + plain(x.b));
  for (const d of health.invalidDate) lines.push("  ? baddate   " + plain(d.node) + " (updated=" + plain(d.updated) + ")");
  for (const s of health.schema) lines.push("  # schema    " + plain(s.node) + " " + plain(s.kind) + " '" + plain(s.key) + "'");
  for (const d of health.drift) lines.push("  = drift     declared " + d.declared + " vs actual " + d.actual);
  for (const s of health.stale) lines.push("  . stale     " + plain(s.node) + " (neighbor " + plain(s.newerNeighbor) + " newer)");
  for (const u of health.unsourced) lines.push("  ~ unsourced " + plain(u.node) + " (" + plain(u.status) + ", no provenance link)");
  return lines.join("\n");
}
