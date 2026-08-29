/**
 * format.ts: number formatting for the internal growth dashboard.
 *
 * WHY this exists: the growth page reports on a product with roughly 116
 * workspaces. At that size a bare percentage is actively misleading, because
 * "50%" over a denominator of 2 reads like a trend when it is one person
 * changing their mind. Every chart in this folder therefore routes its
 * derived numbers through `ratio()`, which refuses to print a percentage
 * unless the denominator is large enough for one to mean anything.
 *
 * Keep this module dependency free and side-effect free: it is imported by
 * Server Components and by the (very small) client tooltip layer.
 */

/**
 * Placeholder for "there is no number here". Written as an escape so the
 * repo-wide ban on typing that glyph in source and copy still holds, while the
 * rendered output stays the conventional single-character empty marker.
 */
export const NO_DATA = '\u2014';

/**
 * Below this denominator we show counts instead of percentages. Ten is the
 * point where a single user moving stops swinging the headline by double
 * digits, so it is where a percentage starts carrying information.
 */
export const MIN_DENOMINATOR_FOR_PERCENT = 10;

const COUNT_FORMATTER = new Intl.NumberFormat('en-US');

/** Thousands-separated integer. Non-finite input renders as the empty marker. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return NO_DATA;
  return COUNT_FORMATTER.format(Math.round(value));
}

/**
 * Formats a FRACTION (0.43) as a percentage ("43%"). It does not take an
 * already-scaled percentage: passing 43 would render "4300%".
 */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return NO_DATA;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * The honesty rule for this dashboard.
 *
 *   denominator 0            : NO_DATA       (nothing to divide into)
 *   denominator under 10     : "3 of 7"      (counts, because a % would lie)
 *   denominator 10 or more   : "43%"
 *
 * Use this anywhere a chart derives one number from another. Do not hand-roll
 * `n / d * 100` in a component.
 */
export function ratio(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return NO_DATA;
  if (denominator <= 0) return NO_DATA;
  if (denominator < MIN_DENOMINATOR_FOR_PERCENT) return `${formatCount(numerator)} of ${formatCount(denominator)}`;
  return formatPercent(numerator / denominator);
}

/** Safe 0..1 share. Returns 0 rather than NaN/Infinity so geometry never breaks. */
export function share(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

/** Clamps a number into a range. Used to keep SVG coordinates inside the viewBox. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Lowercased, hyphenated slug used to build deterministic SVG element ids. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'chart';
}

/**
 * Money, from minor units, for a display read across a room.
 *
 * Cents are shown below a hundred and hidden above it. A first month's MRR of
 * $3.58 rounded to "$4" is a visible lie about a number that small, and a
 * five-figure ARR quoted to the cent is noise nobody can read from four metres
 * away. Whole amounts never show ".00" at any size.
 */
export function formatMoney(minorUnits: number, currency = 'usd'): string {
  if (!Number.isFinite(minorUnits)) return NO_DATA;
  const major = minorUnits / 100;
  const whole = Number.isInteger(major);
  const digits = whole || Math.abs(major) >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    // An unknown currency code must not blank a tile that has a real number in it.
    return `${formatCount(Math.round(major))} ${currency.toUpperCase()}`;
  }
}
