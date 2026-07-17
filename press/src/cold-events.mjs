// cold-events.mjs  -  render the per-day data in data/cold-events.md into[segment timeline + Daily table]
// data-driven·SSOT: source is data/cold-events.md; rebuild after editing.
import { escapeHtml } from "./shared/escape.mjs";
// format: `### D{n}` marks a day; each line below: `- source | event | anchor | character-lines | target`
//   anchor: "fact" = a hard historical anchor; empty = fiction overlay.
//   character-lines: optional; comma-separated, rendered as [[wiki-links]].
//   target: optional; present = arrow A->B, empty = a Note (A acts alone).

export function parseCold(txt) {
  const ev = [];
  let day = -1;
  for (const line of txt.split(/\r?\n/)) {
    const dm = line.match(/^###\s*D(\d+)/);
    // the model is a fixed 30-day base (titles, segments, and the daily table all assume D0–30).
    // A day outside that range would be silently mislabeled into "③ after (D21–30)" and dropped
    // from the diagrams — so ignore its section entirely, the same as text before any `### D`.
    if (dm) { day = +dm[1]; if (day > 30) day = -1; continue; }
    const im = line.match(/^\s*-\s+(.+)$/);
    if (im && day >= 0) {
      const p = im[1].split("|").map((s) => s.trim());
      if (p[0] && p[1]) ev.push({ day, faction: p[0], event: p[1], anchor: p[2] || "", links: p[3] || "", target: p[4] || "" });
    }
  }
  return ev;
}

// strip characters that break mermaid sequence-diagram structure (grill M14):
// participant/arrow identifiers must not contain delimiters/arrows; message text
// must not contain newlines or `;`.
function mmId(s) {
  return String(s).replace(/[;:#<>"'`{}()[\]|]/g, "").replace(/-+>+/g, "→").replace(/\s+/g, " ").trim() || "?";
}
function mmText(s) {
  return String(s).replace(/[\r\n;]+/g, " ").trim();
}

const esc = (s) => escapeHtml(String(s == null ? "" : s)); // the ONE escaper (also handles quotes)

function segDoc(events, lo, hi, name) {
  const seg = events.filter((e) => e.day >= lo && e.day <= hi);
  const head = "<article data-generated=\"cold-events\"><h1>Cold events · D" + lo + "–" + hi + " (" + esc(name) + ")</h1>";
  if (!seg.length) return head + "<blockquote><p>fill in the per-day data in <code>data/cold-events.md</code>.</p></blockquote></article>";
  // Assign each DISTINCT original faction/target its own participant id. mmId strips delimiters,
  // so two different names (`A:B` and `AB`) would collapse to one participant and silently merge
  // their events — give every original a unique id and carry the readable name as the `as` label.
  const pid = new Map();
  const idOf = (orig) => { if (!pid.has(orig)) pid.set(orig, "p" + pid.size); return pid.get(orig); };
  for (const e of seg) for (const orig of [e.faction, e.target].filter(Boolean)) idOf(orig);
  const ids = [...pid.values()];
  let g = "sequenceDiagram\n";
  for (const [orig, id] of pid) g += "  participant " + id + " as " + mmId(orig) + "\n";
  if (ids.length > 1) g += "  Note over " + ids[0] + "," + ids[ids.length - 1] + ": D" + lo + "–" + hi + " · " + mmText(name) + "\n";
  const days = [...new Set(seg.map((e) => e.day))].sort((a, b) => a - b);
  days.forEach((d, i) => {
    g += "  rect " + (i % 2 ? "rgb(252,251,247)" : "rgb(243,240,231)") + "\n"; // one band per day, alternating, isolating days
    for (const e of seg.filter((x) => x.day === d)) {
      const tag = e.anchor === "fact" ? "[fact]" : "";
      if (e.target) g += "    " + idOf(e.faction) + "->>" + idOf(e.target) + ": D" + d + "·" + mmText(e.event) + tag + "\n";
      else g += "    Note over " + idOf(e.faction) + ": D" + d + "·" + mmText(e.event) + tag + "\n";
    }
    g += "  end\n";
  });
  const links = [...new Set(seg.flatMap((e) => (e.links ? e.links.split(",").map((s) => s.trim()) : [])))].filter(Boolean);
  let body = head + "<blockquote><p>external base independent of character agency (data-driven; edit <code>data/cold-events.md</code> → build).</p></blockquote>";
  body += '<div class="mermaid">' + esc(g) + "</div>";
  if (links.length) body += "<h2>character lines this segment touches</h2><p>" + links.map((l) => "[[" + l + "]]").join(" · ") + "</p>";
  body += "<blockquote><p>daily detail in [[Daily table · 30 days]].</p></blockquote></article>";
  return body;
}

function dailyDoc(events) {
  let body = "<article data-generated=\"cold-events\"><h1>Daily table · 30 days</h1>";
  body += "<blockquote><p>30 per-day slices: what each force did each day (data-driven). [fact] = hard anchor (canon). <strong>Each day's section is a hook for character drama.</strong></p></blockquote>";
  const days = [...new Set(events.map((e) => e.day))].sort((a, b) => a - b);
  let curSeg = "";
  for (const d of days) {
    const seg = d <= 10 ? "① before (D0–10)" : d <= 20 ? "② during (D11–20)" : "③ after (D21–30)";
    if (seg !== curSeg) { body += "<h2>" + esc(seg) + "</h2>"; curSeg = seg; }
    body += "<h3>D" + d + "</h3><ul>";
    for (const e of events.filter((x) => x.day === d)) {
      const tag = e.anchor === "fact" ? " [fact]" : "";
      const arrow = e.target ? " → " + esc(e.target) : "";
      const ln = e.links ? " " + e.links.split(",").map((s) => "[[" + s.trim() + "]]").join(" ") : "";
      body += "<li><strong>" + esc(e.faction) + "</strong>" + arrow + ": " + esc(e.event) + tag + ln + "</li>";
    }
    body += "</ul>";
  }
  return body + "</article>";
}

// expand cold-events data into the generated timeline docs — returns a { title: doc } object.
export function coldEventDocs(events) {
  const docs = {};
  docs["Cold events · D0–30 full"] = { group: "timeline", icon: "clock", meta: { type: "30-day base · full diagram", status: "🔨 data-driven" }, body: segDoc(events, 0, 30, "full · 31 days") };
  for (const [lo, hi, name] of [[0, 10, "before"], [11, 20, "during"], [21, 30, "after"]]) {
    const title = "Cold events · D" + lo + "–" + hi + " " + name;
    docs[title] = { group: "timeline", icon: "clock", meta: { type: "30-day base · segment timeline", status: "🔨 data-driven" }, body: segDoc(events, lo, hi, name) };
  }
  docs["Daily table · 30 days"] = { group: "timeline", icon: "clock", meta: { type: "30-day base · daily slice", status: "🔨 data-driven" }, body: dailyDoc(events) };
  return docs;
}
