/**
 * Shared, stateless UI helpers used across the JS modules that render
 * page fragments. Stays small on purpose; if it grows past ~5 functions,
 * split it by concern.
 */

const ESCAPE_MAP = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * HTML-text escape. Safe for both text content AND attribute values
 * because we also escape `"` and `'`. Treats nullish input as ''.
 */
export function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ESCAPE_MAP[c]);
}
export const escapeAttr = escapeText;

/** Trailing-edge debounce. Returns a function with the same arity. */
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/**
 * Human-readable byte count. Renders '0 B' for zero / negative / non-finite
 * inputs so callers don't have to pre-validate.
 */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
