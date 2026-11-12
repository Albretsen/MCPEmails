/**
 * Seeded small choices for v09 (brief variant_seed 1166650964), so taste calls
 * are reproducible. Every choice made here is listed in README.md.
 */
export const VARIANT_SEED = 1166650964;

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

/** Tint of every email header block: warm paper or the faintest cobalt. */
export const HEADER_TINT = pick(['paper', 'cobalt']);
/** Which numbered message the index marks unread (a cobalt dot). */
export const UNREAD = pick(['01', '02', '03', '04', '05', '06', '07']);
/** Ledger line pitch in px for pricing and spec tables. */
export const LEDGER_PITCH = pick([36, 40, 44]);
/** Hero: the draft card sits to the right of or under the held send. */
export const HERO_STACK = pick(['offset', 'under']);
/** Envelope crops for step markers 1, 2, 3 (a shuffle of three framings). */
const CROPS = [
  { x: 18, y: 22, r: -8 },
  { x: 62, y: 30, r: 6 },
  { x: 40, y: 70, r: -3 },
];
for (let i = CROPS.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rng() * (i + 1));
  [CROPS[i], CROPS[j]] = [CROPS[j], CROPS[i]];
}
export const ENVELOPE_CROPS = CROPS;
