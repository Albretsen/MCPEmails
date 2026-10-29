/**
 * FNV-1a, 32-bit, seedable. Not a security primitive: a cache and comparison
 * key. One copy for persist.ts and draft-signal.ts.
 */
export function fnv1a(s: string, seed = 0x811c9dc5): string {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
