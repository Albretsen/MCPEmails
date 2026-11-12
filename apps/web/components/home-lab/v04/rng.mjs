/**
 * Seeded choices for v04 (brief variant_seed 1373657159). Small decisions that
 * would otherwise be taste are drawn here once, at module load, so every
 * render makes the same ones. The README lists what each draw decided.
 */
export const VARIANT_SEED = 1373657159;

export function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(VARIANT_SEED);
const draws = [rng(), rng(), rng(), rng(), rng()];

export const CHOICES = {
  /** Which word of the seven-word provider headline carries a permanent cobalt-200 rule (0.34 -> 2, iCloud). */
  italicWord: Math.floor(draws[0] * 7),
  /** Plate numerals: arabic below 0.5, roman above (0.58 -> roman). */
  romanPlates: draws[1] >= 0.5,
  /** Alternate surface tint: cobalt-50 below 0.5, cobalt-100 above (0.21 -> cobalt-50). */
  tint: draws[2] < 0.5 ? 'c50' : 'c100',
  /** Duotone shadow: cobalt-900 below 0.5, cobalt-700 above (0.06 -> cobalt-900). */
  duoShadow: draws[3] < 0.5 ? '#0E1750' : '#16299A',
  /** Client tab open by default (0.11 -> 0, Claude). */
  defaultTab: Math.floor(draws[4] * 4),
};

export function roman(n) {
  return ['I', 'II', 'III', 'IV', 'V', 'VI'][n - 1] ?? String(n);
}

export function plateNumeral(n) {
  return CHOICES.romanPlates ? roman(n) : String(n);
}
