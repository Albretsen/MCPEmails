/**
 * Deterministic bucketing. Pure, zero imports, safe in the middleware runtime.
 *
 * The same subject id always lands in the same variant for a given experiment
 * key, with no database read, so a page can decide what to render before it
 * has talked to anything. The stored assignment (see resolve.ts) is what makes
 * that decision permanent afterwards; this function only decides where a
 * brand-new subject goes.
 */
import { SUBJECT_ID_PATTERN, VARIANT_ID_PATTERN, type ExperimentVariant } from './constants.ts';

/**
 * cyrb53, a well-known 53-bit non-cryptographic string hash. Not a security
 * boundary: it decides which of two homepages someone sees. What it has to be
 * is fast, stable across runtimes, and evenly spread, which a plain
 * charCodeAt sum is not.
 */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A stable number in [0, 1) for this subject in this experiment.
 *
 * The experiment key is part of the hashed string on purpose: without it every
 * experiment would split the population along the exact same line, and the
 * same people would be in the treatment arm of all of them forever.
 */
export function hashUnit(subjectId: string, experimentKey: string): number {
  return cyrb53(`${experimentKey}:${subjectId}`) / 2 ** 53;
}

/**
 * Walk the cumulative weights and return the variant the unit falls in.
 *
 * Weights are integers out of 100. A zero-weight variant can never be picked
 * (its slice has no width), which is what lets an experiment ship at 100/0 and
 * be opened up later without moving anybody who was already bucketed. If
 * floating point walks off the end of the last slice, the last variant with a
 * positive weight absorbs it rather than the function returning undefined.
 */
export function pickVariant(variants: ExperimentVariant[], unit: number): string {
  const scaled = unit * 100;
  let cumulative = 0;
  let lastPositive: string | null = null;
  for (const variant of variants) {
    if (variant.weight <= 0) continue;
    lastPositive = variant.id;
    cumulative += variant.weight;
    if (scaled < cumulative) return variant.id;
  }
  // Every weight was zero (an invalid experiment) or rounding fell off the
  // end. Neither should reach a visitor, and neither is worth throwing over.
  return lastPositive ?? variants[0]?.id ?? 'control';
}

/**
 * The same rules the database CHECK constraint enforces, restated here so the
 * admin panel can say what is wrong in words before the insert fails with a
 * constraint name. Returns an error message, or null when the list is valid.
 */
export function validateVariants(variants: unknown): string | null {
  if (!Array.isArray(variants)) return 'Variants must be a list.';
  if (variants.length < 1) return 'An experiment needs at least one variant.';
  if (variants.length > 10) return 'An experiment can have at most 10 variants.';

  const seen = new Set<string>();
  let total = 0;
  for (const raw of variants) {
    if (!raw || typeof raw !== 'object') return 'Each variant must be an object.';
    const variant = raw as Partial<ExperimentVariant>;
    if (typeof variant.id !== 'string' || !VARIANT_ID_PATTERN.test(variant.id)) {
      return `Variant id "${String(variant.id)}" must be 1 to 32 characters of lowercase letters, digits or underscores.`;
    }
    if (seen.has(variant.id)) return `Variant id "${variant.id}" is used twice.`;
    seen.add(variant.id);
    if (typeof variant.label !== 'string' || variant.label.trim() === '') {
      return `Variant "${variant.id}" needs a label.`;
    }
    if (typeof variant.weight !== 'number' || !Number.isInteger(variant.weight)) {
      return `Variant "${variant.id}" needs a whole-number weight.`;
    }
    if (variant.weight < 0 || variant.weight > 100) {
      return `Variant "${variant.id}" has weight ${variant.weight}; weights run from 0 to 100.`;
    }
    total += variant.weight;
  }
  if (total !== 100) return `Weights add up to ${total}, and they have to add up to 100.`;
  return null;
}

/** True only for a 32 character lowercase hex subject id. */
export function isValidSubjectId(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_ID_PATTERN.test(value);
}
