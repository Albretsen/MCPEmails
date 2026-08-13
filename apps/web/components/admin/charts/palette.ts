/**
 * palette.ts: the one series palette for the growth dashboard.
 *
 * WHY a shared array: the growth page stacks half a dozen charts on one
 * screen. If each chart picked its own colours, "the blue line" would mean
 * something different in every card. Series N is the same colour everywhere.
 *
 * Every entry is a `var()` reference, never a literal hex, so light and dark
 * both come from the tokens in colors_and_type.css / theme.css. The tokens
 * chosen here are the ones that stay legible in BOTH themes (cobalt-700, for
 * example, is nearly invisible on the dark page background, so it is out).
 *
 * Colour is never the only signal: charts that use more than one series must
 * also render a labelled legend, and the exact numbers live in the frame's
 * collapsed table.
 */

export const SERIES_COLORS: readonly string[] = [
  'var(--brand)',
  'var(--mint-500)',
  'var(--amber-500)',
  'var(--cobalt-300)',
  'var(--red-500)',
  'var(--fg-3)',
];

/** Colour for series index N, wrapping if a chart somehow has more than six. */
export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** Semantic fills for the capacity meter. Not part of the series ramp. */
export const STATUS_COLORS = {
  ok: 'var(--mint-500)',
  warn: 'var(--amber-500)',
  danger: 'var(--red-500)',
} as const;

export type StatusKey = keyof typeof STATUS_COLORS;
