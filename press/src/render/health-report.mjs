// render/health-report — render the health layer into (a) a board doc (HTML) and
// (b) a CLI text summary. The board "view" is a generated doc, like the timeline.
// [[id]] links are resolved + the HTML sanitized by build.mjs before shipping.
import { healthTotal } from "../derive/health.mjs";
import { escapeHtml } from "../shared/escape.mjs";

const wl = (id) => "[[" + id + "]]";
const esc = (s) => escapeHtml(String(s == null ? "" : s));

export function renderHealthHtml(health) {
  const c = health.counts;
  const clean = healthTotal(health) === 0;
  let b = '<article data-generated="health"><h1>Health</h1>';
  b += "<blockquote><p>Automatic, deterministic check (no LLM) of the read-only projection — it watches for what the writing side hasn't caught up on.";
  if (health.now) b += "<br>Baseline <code>" + esc(health.now) + "</code>, stale window " + c.stale + " · " + health.staleWindowDays + " days.";
  b += "</p></blockquote>";

  const rows = [
    ["Dangling links (likely rename/typo)", c.dangling],
    ["Orphans (no links in or out)", c.orphan],
    ["Contradictions (typed <code>contradicts</code>)", c.contradiction],
    ["Invalid dates (bad <code>updated</code>)", c.invalidDate],
    ["<code>_types</code> schema violations", c.schema],
    ["Ledger drift (declared ≠ actual)", c.drift],
    ["Stale (neighbors moved, this didn't)", c.stale],
    ["Unsourced (a claim with no provenance)", c.unsourced],
  ];
  b += '<table class="wb-table"><thead><tr><th>Check</th><th class="num">Count</th></tr></thead><tbody>' +
    rows.map(([k, v]) => "<tr><td>" + k + '</td><td class="num">' + v + "</td></tr>").join("") +
    "</tbody></table>";

  if (clean) return b + "<blockquote><p>✅ No findings. The knowledge base is consistent.</p></blockquote></article>";

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
    b += section("Stale", c.stale, "Hasn't changed in a while, but a doc it links to was updated more recently — may need a revisit.",
      tbl(["Document", "Updated", "Newer neighbor"], health.stale.map((s) => "<tr><td>" + wl(s.node) + "</td><td>" + esc(s.updated) + "</td><td>" + wl(s.newerNeighbor) + "</td></tr>").join("")));
  }
  if (c.unsourced) {
    b += section("Unsourced", c.unsourced, "This page states a claim (it carries a trust tier) but links back to nothing that justifies it. Add a body <code>**Sources.**</code> line linking the minute the claim came from — a frontmatter <code>sources:</code> key is not provenance.",
      tbl(["Document", "Tier"], health.unsourced.map((u) => "<tr><td>" + wl(u.node) + "</td><td><code>" + esc(u.status) + "</code></td></tr>").join("")));
  }
  return b + "</article>";
}

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
  for (const d of health.dangling) lines.push("  x dangling  " + d.source + " -> " + d.target + " (" + (d.edgeType || "body") + ")");
  for (const o of health.orphan) lines.push("  o orphan    " + o.node);
  for (const x of health.contradiction) lines.push("  ! contra    " + x.a + " <> " + x.b);
  for (const d of health.invalidDate) lines.push("  ? baddate   " + d.node + " (updated=" + d.updated + ")");
  for (const s of health.schema) lines.push("  # schema    " + s.node + " " + s.kind + " '" + s.key + "'");
  for (const d of health.drift) lines.push("  = drift     declared " + d.declared + " vs actual " + d.actual);
  for (const s of health.stale) lines.push("  . stale     " + s.node + " (neighbor " + s.newerNeighbor + " newer)");
  for (const u of health.unsourced) lines.push("  ~ unsourced " + u.node + " (" + u.status + ", no provenance link)");
  return lines.join("\n");
}
