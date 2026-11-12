/**
 * Small layout choices for v01, made by the brief's `variant_seed` instead of
 * by taste (home-lab/builder-rules.md, Craft). Deterministic: the same seed
 * always gives the same page.
 */
export const VARIANT_SEED = 198879164;

export function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r * list.length)];

const rng = mulberry32(VARIANT_SEED);
const draws = Array.from({ length: 6 }, () => rng());

export const CHOICES = {
  /** The one section that sits on the ink-50 tinted band. */
  tintedSection: pick(draws[0], ['spec', 'connect', 'ask', 'providers', 'beliefs']),
  /** Number style in the catalogue index and section labels. */
  numberStyle: pick(draws[1], ['roman', 'padded']),
  /** Which of the three sample drafts in the hero is held for approval (amber). */
  heldDraft: pick(draws[2], [0, 1, 2]),
  /** Section head rule: a single hairline or a double rule. */
  sectionRule: pick(draws[3], ['single', 'double']),
  /** Figure captions above or below the plate. */
  captionSide: pick(draws[4], ['above', 'below']),
  /** Which real clip loops in the hero. */
  heroClip: pick(draws[5], ['card-draft-send', 'card-approval-flow']),
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** "01" or "I" for a 1-based index, per the seeded number style. */
export function numeral(n) {
  return CHOICES.numberStyle === 'roman' ? ROMAN[n - 1] : String(n).padStart(2, '0');
}
