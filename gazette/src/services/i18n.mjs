// services/i18n — text identity & collation (PRD §12). Author works in Chinese;
// titles must match under Unicode normalization, and sorting must be locale-aware.

// Canonical identity form for a title/link target. NFC so visually-identical CJK
// (and composed/decomposed Latin) compare equal.
export function nfc(s) {
  return String(s).normalize("NFC");
}

// Locale-aware compare for stable, human-sensible ordering of CJK + Latin.
const collator = new Intl.Collator(["zh-Hans", "en"], { numeric: true });
export function compare(a, b) {
  return collator.compare(String(a), String(b));
}

export function sortBy(arr, key) {
  return [...arr].sort((a, b) => compare(key(a), key(b)));
}
