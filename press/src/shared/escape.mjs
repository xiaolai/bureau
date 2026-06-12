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
