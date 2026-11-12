/**
 * Seeded choices for v08 (brief variant_seed 1964509051). Small decisions that
 * would otherwise be taste are drawn here, in a fixed order, so the page is
 * reproducible. README.md lists what each draw decided.
 */
export const VARIANT_SEED = 1964509051;

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

/** Side the first screenshot between spec groups hangs on; later ones alternate. */
export const FIRST_FIGURE_SIDE = draws[0] < 0.5 ? 'left' : 'right';
/** Tint of the alternating spec rows: ink-25 or ink-50. */
export const ZEBRA = ['#FAFBFD', '#F5F6FA'][Math.floor(draws[1] * 2)];
/** Prefix of the museum labels under every figure. */
export const CAPTION_PREFIX = ['Fig.', 'Object', 'Plate'][Math.floor(draws[2] * 3)];
/** The one spec key that carries the cobalt mark. */
export const ACCENT_KEY = ['Providers', 'Clients', 'Data location', 'Storage', 'Approval', 'Revoke', 'Plans'][Math.floor(draws[3] * 7)];
/** Index numerals: decimal (01) or roman (I). */
export const INDEX_STYLE = draws[4] < 0.5 ? 'decimal' : 'roman';
