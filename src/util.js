// Small shared helpers -- same conventions as servicem8-renewal-autopilot/src/util.js.

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ServiceM8's zero-date sentinel ("0000-00-00 00:00:00") -- an unset date
// field comes back as this string rather than null/empty. Returns a Date or
// null; used only to tell "genuinely unset" apart from "has a value", not for
// display (email.json's date strings are the installing account's own local
// time, not UTC -- reformatting through Date would silently shift them).
export function parseServiceM8Date(s) {
  if (!s || s.startsWith("0000-00-00")) return null;
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? null : d;
}
