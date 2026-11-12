/**
 * Seeded small choices for v06 (brief variant_seed 609717239). Drawn once at
 * module load, so every render makes the same ones. README lists the results.
 */
export const VARIANT_SEED = 609717239;

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
const d = [rng(), rng(), rng(), rng(), rng()];

export const CHOICES = {
  /** Hero long shadow falls to the right below 0.5 (0.17 -> right). */
  shadowSide: d[0] < 0.5 ? 'right' : 'left',
  /** Which demo rows sit on the cobalt-50 band: odd below 0.5 (0.02 -> odd: 1, 3, 5). */
  tintOdd: d[1] < 0.5,
  /** Postbox column: left below 0.5 (0.03 -> left), labels to its right. */
  postboxSide: d[2] < 0.5 ? 'left' : 'right',
  /** Blueprint major grid line every 64 px below 0.5, else 80 px (0.46 -> 64). */
  majorGrid: d[3] < 0.5 ? 64 : 80,
  /** Mono text colour: cobalt-700 below 0.5, else ink-700 (0.49 -> cobalt-700). */
  monoInk: d[4] < 0.5 ? '#16299A' : '#2F3447',
};
