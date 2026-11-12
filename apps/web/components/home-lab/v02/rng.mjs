/**
 * Seeded small choices for v02 (brief variant_seed 2027062686). Every choice
 * the builder would otherwise make by taste comes from here, so a re-run of
 * the same seed renders the same page. README lists what each one picked.
 */
export const VARIANT_SEED = 2027062686;

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
const pick = (list) => list[Math.floor(rng() * list.length)];

/** Which chapter (besides the FAQ appendix) the manual opens on. */
const openChapter = pick(['answer', 'how']);
/** Magazine grid rhythm: tall tile on the right ('a') or the left ('b'). */
const gridRhythm = pick(['a', 'b']);
/** Leader style on the contents lines. */
const leader = pick(['dots', 'dashes']);
/** Manual page numbers: start page plus a seeded gap of 2 to 6 pages each. */
const pageStart = 3 + Math.floor(rng() * 3);
const pageGaps = Array.from({ length: 8 }, () => 2 + Math.floor(rng() * 5));
/** Default provider in the "Which inbox do you use?" picker. */
const defaultProvider = pick(['imap', 'imap', 'gmail', 'outlook']);

export const choices = { openChapter, gridRhythm, leader, pageStart, pageGaps, defaultProvider };

/** Page number for the nth contents line. */
export function pageFor(index) {
  let p = pageStart;
  for (let i = 0; i < index; i += 1) p += pageGaps[i];
  return p;
}
