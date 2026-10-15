/**
 * Return the exact decoded size of a standard base64 payload, or null when the
 * value is malformed. This is deliberately stricter than atob alone: atob
 * accepts a few non-canonical inputs, while attachment data must be portable
 * to the provider/dispatcher that eventually consumes it.
 */
export function decodedBase64ByteLength(data: string): number | null {
  // A linear scan, never a regular expression. The pattern this replaced,
  // /^(?:[A-Za-z0-9+/]{4})*(...)?$/, backtracks per group, and V8 ran out of
  // stack on it from about 3 MB of input (measured 2026-10-15): every inline
  // attachment above that came back as a JSON-RPC internal error instead of
  // being stored or refused, under a documented 10 MB limit. The size is
  // computed arithmetically too, so a 10 MB payload is not decoded just to be
  // measured.
  let symbols = 0;
  let padding = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    // Whitespace (line breaks in wrapped base64) is ignored, as before.
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) continue;
    if (c === 0x3d /* = */) {
      padding++;
      continue;
    }
    // Data after padding is malformed.
    if (padding > 0) return null;
    const alnum = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
    if (!alnum && c !== 0x2b /* + */ && c !== 0x2f /* / */) return null;
    symbols++;
  }
  // Canonical only, as before: whole 4-character quanta, and padding that
  // completes the last one ("AB==", "ABC="), never more than two.
  if ((symbols + padding) % 4 !== 0 || padding > 2) return null;
  if (padding > 0 && symbols % 4 !== 4 - padding) return null;
  // Each symbol is 6 bits; a partial last quantum carries 1 or 2 bytes.
  return Math.floor((symbols * 3) / 4);
}
