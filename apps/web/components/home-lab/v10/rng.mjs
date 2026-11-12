/**
 * Seeded small choices for v10 (brief variant_seed 1065250005), so taste calls
 * are reproducible. Every choice made here is listed in README.md.
 */
export const VARIANT_SEED = 1065250005;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(VARIANT_SEED);
const pick = (options) => options[Math.floor(rng() * options.length)];

/** Which client tab is open on first load (both lead clients qualify). */
export const DEFAULT_CLIENT = pick(['claude', 'chatgpt']);
/** Tint behind figures and marginalia panels. */
export const FIGURE_TINT = pick(['ink', 'cobalt']);
/** Section numbering style. */
export const NUMBER_STYLE = pick(['section', 'figure']);
/**
 * Where each section's single solid cobalt block sits: either the section's
 * number tab, or the one content element the section names as its candidate.
 */
export const COBALT = {
  providers: pick(['number', 'content']),
  how: pick(['number', 'content']),
  security: pick(['number', 'content']),
  uses: pick(['number', 'content']),
  reviews: pick(['number', 'content']),
  pricing: pick(['number', 'content']),
  faq: 'number',
};
/** Initial position of the before/after divider, in percent. */
export const DIVIDER_START = 38 + Math.round(rng() * 24);
