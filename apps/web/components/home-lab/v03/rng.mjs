/**
 * Seeded choices for v03. `variant_seed` comes from home-lab/briefs/v03.json,
 * so every "taste" decision below is reproducible and listed in README.md.
 */
export const VARIANT_SEED = 306090038;

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

/** Which track carries the cobalt-50 tint; the other stays white paper. */
export const TINTED_TRACK = pick(['team', 'you']);
/** How many cancellation waves trail each postmark. */
export const WAVE_COUNT = pick([3, 4, 5]);
/** Inner ring of the postmark: solid or dashed. */
export const INNER_RING = pick(['solid', 'dashed']);
/** A small rotation per postmark, in degrees, so the stamps look struck by hand. */
export const POSTMARK_TILT = Array.from({ length: 8 }, () => Math.round((rng() * 16 - 8) * 10) / 10);
/** Which side of the P.S. the signature sits on at desktop width. */
export const SIGNATURE_SIDE = pick(['left', 'right']);
