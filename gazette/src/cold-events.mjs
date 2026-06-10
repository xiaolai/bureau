// cold-events.mjs  -  render the per-day data in data/cold-events.md into[segment timeline + Daily table]
// data-driven·SSOT: source is data/cold-events.md; rebuild after editing.
// format: `### D{n}` marks a day; each line below: `- source | event | anchor | character-lines | target`
//   anchor: "fact" = a hard historical anchor; empty = fiction overlay.
//   character-lines: optional; comma-separated, rendered as [[wiki-links]].
//   target: optional; present = arrow A->B, empty = a Note (A acts alone).

export function parseCold(txt) {
  const ev = [];
  let day = -1;
  for (const line of txt.split(/\r?\n/)) {
    const dm = line.match(/^###\s*D(\d+)/);
    if (dm) { day = +dm[1]; continue; }
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

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function segDoc(events, lo, hi, name) {
  const seg = events.filter((e) => e.day >= lo && e.day <= hi);
  const head = "<article data-generated=\"cold-events\"><h1>Cold events · D" + lo + "–" + hi + " (" + esc(name) + ")</h1>";
  if (!seg.length) return head + "<blockquote><p>fill in the per-day data in <code>data/cold-events.md</code>.</p></blockquote></article>";
  const facs = [...new Set(seg.flatMap((e) => [e.faction, e.target].filter(Boolean).map(mmId)))];
  let g = "sequenceDiagram\n";
  facs.forEach((f) => (g += "  participant " + f + "\n"));
  if (facs.length > 1) g += "  Note over " + facs[0] + "," + facs[facs.length - 1] + ": D" + lo + "–" + hi + " · " + mmText(name) + "\n";
  const days = [...new Set(seg.map((e) => e.day))].sort((a, b) => a - b);
  days.forEach((d, i) => {
    g += "  rect " + (i % 2 ? "rgb(252,251,247)" : "rgb(243,240,231)") + "\n"; // one band per day, alternating, isolating days
    for (const e of seg.filter((x) => x.day === d)) {
      const tag = e.anchor === "fact" ? "[fact]" : "";
      if (e.target) g += "    " + mmId(e.faction) + "->>" + mmId(e.target) + ": D" + d + "·" + mmText(e.event) + tag + "\n";
      else g += "    Note over " + mmId(e.faction) + ": D" + d + "·" + mmText(e.event) + tag + "\n";
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

// expand cold-events data into docs (into STORY.docs). returns the count added.
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
