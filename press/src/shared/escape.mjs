// shared/escape — the ONE HTML-escaper, used by both the Node build (services/
// sanitize) and the browser runtime bundle (src/runtime). No second copy (grill L2).

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function escapeAttr(s) {
  return escapeHtml(s);
}

// Collapse C0/C1 control characters (0x00–0x1F, 0x7F–0x9F) to spaces. For untrusted text — page
// titles, a JSON parse-error echoing a malformed ledger — concatenated into TERMINAL output, where a
// stray ESC/CR/newline could inject ANSI styling or forge lines. Written with code-point comparison
// (no regex escape) so the source can never carry a literal control byte. The ONE such sanitizer.
export function stripControl(s) {
  return Array.from(String(s == null ? "" : s), (ch) => {
    const c = ch.codePointAt(0);
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? " " : ch;
  }).join("");
}
