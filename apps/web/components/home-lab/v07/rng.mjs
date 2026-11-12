/**
 * Seeded choices for v07 (brief variant_seed 637257314). Small decisions that
 * would otherwise be taste are drawn here, in a fixed order, so the page is
 * reproducible. README.md lists what each draw decided.
 */
export const VARIANT_SEED = 637257314;

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

/** Which of the twelve provider plates carries the cobalt frame. */
export const ACCENT_PLATE = Math.floor(draws[0] * 12);
/** Which of three cream mat tones the framed prints sit on. */
export const MAT_TONE = ['#F7F3E9', '#F5F1E5', '#F8F5ED'][Math.floor(draws[1] * 3)];
/** Section-head rule: a newspaper double rule or a thick-over-thin rule. */
export const RULE_STYLE = draws[2] < 0.5 ? 'double' : 'thickThin';
/** Side rail order: providers before plans, or plans first. */
export const RAIL_PROVIDERS_FIRST = draws[3] < 0.5;
/** How many changelog dispatches the page prints (5 or 6). */
export const DISPATCH_COUNT = 5 + Math.floor(draws[4] * 2);
