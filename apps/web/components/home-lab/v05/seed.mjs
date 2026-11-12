/**
 * Small choices for v05, taken from the brief's variant_seed instead of taste.
 * The README lists what each draw decided.
 */
export const VARIANT_SEED = 384930780;

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
const pick = (list) => list[Math.floor(rng() * list.length)];

export const SEED = {
  /** Panel grey: one of three ink tints for the hardware panels. */
  panel: pick(['#F5F6FA', '#F1F2F7', '#ECEEF4']),
  /** Which setup step (0 clip .. 5 sent) carries the one cobalt-50 panel. */
  accentStep: pick([0, 1, 2, 3, 4]),
  /** Vertical rhythm between sections, in px. */
  rhythm: pick([96, 120, 144]),
  /** Step numbering style on the labels. */
  numbering: pick(['01', 'a1', 's1']),
  /** Corner radius of screenshot frames, in px. */
  frameRadius: pick([2, 4, 8]),
};

export function stepNumber(i) {
  const n = String(i).padStart(2, '0');
  if (SEED.numbering === 'a1') return `a${i}`;
  if (SEED.numbering === 's1') return `s${i}`;
  return n;
}
