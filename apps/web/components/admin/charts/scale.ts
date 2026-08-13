/**
 * scale.ts: the small amount of maths the SVG charts need.
 *
 * WHY this exists: every plot in this folder draws into a 0..100 by 0..100
 * viewBox with `preserveAspectRatio="none"`, so its coordinates are literally
 * percentages of the container. That choice is what makes these charts
 * responsive without any JavaScript: the browser stretches the marks, CSS
 * keeps the strokes one pixel wide, and all the text lives in HTML next to the
 * SVG rather than inside it (SVG text would shrink to nothing in a 320px card
 * and balloon in a 1400px one).
 *
 * The functions here turn data into those percentages, and pick round axis
 * ticks so the y axis reads 0/25/50/75/100 rather than 0/23.4/46.8.
 */

/** The plot coordinate space. Both axes are percentages of the rendered box. */
export const VIEW = 100;

/** Rounds a rough step up to the nearest 1, 2, 5 or 10 times a power of ten. */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

export type Axis = { max: number; ticks: number[] };

/**
 * Builds a y axis from 0 to a rounded-up maximum with roughly `count`
 * gridlines. An empty or all-zero series still gets a sane 0..1 axis so the
 * chart renders a baseline instead of dividing by zero.
 */
export function axisFrom(maxValue: number, count = 4): Axis {
  const safeMax = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 1;
  const step = niceStep(safeMax / count);
  const max = step * Math.ceil(safeMax / step);
  const ticks: number[] = [];
  // Float accumulation drifts, so step by index and round to the step's scale.
  const steps = Math.round(max / step);
  for (let i = 0; i <= steps; i += 1) ticks.push(Number((step * i).toPrecision(12)));
  return { max, ticks };
}

/** Converts a value into a y coordinate (0 at the top of the viewBox). */
export function toY(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return VIEW;
  return VIEW - (Math.max(0, value) / max) * VIEW;
}

/** Centre of band `index` when `count` bands share the full width. */
export function bandCenter(index: number, count: number): number {
  if (count <= 0) return VIEW / 2;
  return ((index + 0.5) / count) * VIEW;
}

/** X position of point `index` on a line, where the first and last touch the edges. */
export function pointX(index: number, count: number): number {
  if (count <= 1) return VIEW / 2;
  return (index / (count - 1)) * VIEW;
}

/**
 * How often to print an x-axis label. Ninety daily bars with ninety labels is
 * an unreadable smear, so we aim for about eleven: 90 days lands on every 9th,
 * 28 days on every 3rd, and anything shorter gets every label. Eleven rather
 * than the more obvious one-per-week thirteen because a date like "Aug 13" is
 * about 34px wide and thirteen of them collide in a half-width card. Callers
 * who want an exact weekly cadence pass `tickEvery={7}`. Narrow viewports thin
 * this out further in CSS (see .ac-xtick in admin-charts.css).
 */
export function defaultTickEvery(count: number): number {
  if (count <= 11) return 1;
  return Math.ceil(count / 11);
}

/**
 * Indices that should carry an x-axis label. Counted back from the END so the
 * most recent date is always labelled: on a trailing-90-days chart the reader
 * cares far more about "today" than about the arbitrary left edge.
 */
export function tickIndices(count: number, every: number): number[] {
  const step = Math.max(1, Math.floor(every));
  const indices: number[] = [];
  for (let i = count - 1; i >= 0; i -= step) indices.push(i);
  return indices.reverse();
}

/** Builds an SVG path through the given points, skipping nothing. */
export function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    // A single reading has no direction. Draw a short flat mark so the reader
    // sees a value rather than an empty box.
    const only = points[0];
    return `M ${only.x - 3} ${only.y} L ${only.x + 3} ${only.y}`;
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`).join(' ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
