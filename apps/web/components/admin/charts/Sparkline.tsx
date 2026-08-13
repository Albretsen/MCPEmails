/**
 * Sparkline.tsx: the inch-wide trend line that sits under a stat card number.
 *
 * WHY it has no axes, labels or numbers table: it is not the source of the
 * value, it is context for a number the card already prints in 28px type
 * right above it. The full daily series always exists somewhere else on the
 * page, in a BarSeries or LineChart with its own exact-numbers table. What
 * this component owes a screen-reader user is a sentence, not ninety cells,
 * so its <title> states the direction, the latest reading and the range.
 *
 * The degenerate cases matter more than the happy path here, because a young
 * product produces them constantly: a single data point, a series that is all
 * zeroes, and a series that never moves. None of them may divide by zero and
 * none of them may render an empty box.
 */

import { clamp, formatCount, slugify } from './format';
import { VIEW, linePath, pointX } from './scale';

/** Vertical inset so a flat line at the extreme is not clipped by its own stroke. */
const PAD = 8;

export type SparklineProps = {
  values: number[];
  /** Names the series for assistive tech, for example "New workspaces per day". */
  label: string;
  /** CSS pixels. Default 28, which is the height of the stat card's spare row. */
  height?: number;
  /** A `var(--token)` reference. Defaults to the brand colour. */
  color?: string;
};

export function Sparkline({ values, label, height = 28, color = 'var(--brand)' }: SparklineProps) {
  const clean = values.filter((value) => Number.isFinite(value));
  const titleId = `ac-spark-${slugify(label)}`;

  if (clean.length === 0) {
    return (
      <p className="ac-spark-empty" style={{ height }}>
        No data yet
      </p>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const inner = VIEW - PAD * 2;

  // A flat series (all zero, or all the same number) has no range to scale
  // against. Drawing it down the middle is the honest answer: it says "no
  // movement" instead of pinning it to the top or bottom by accident.
  const points = clean.map((value, index) => ({
    x: pointX(index, clean.length),
    y: span === 0 ? VIEW / 2 : clamp(PAD + inner - ((value - min) / span) * inner, PAD, VIEW - PAD),
  }));

  const path = linePath(points);
  const first = clean[0];
  const last = clean[clean.length - 1];
  const direction = span === 0 ? 'flat' : last > first ? 'up' : last < first ? 'down' : 'flat';

  const title =
    clean.length === 1
      ? `${label}: a single reading of ${formatCount(last)}.`
      : `${label}: ${clean.length} readings, trending ${direction}. Latest ${formatCount(last)}, low ${formatCount(min)}, high ${formatCount(max)}.`;

  return (
    <svg
      className="ac-spark"
      style={{ height }}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>{title}</title>
      <path
        className="ac-spark-area"
        d={`${path} L ${VIEW} ${VIEW} L 0 ${VIEW} Z`}
        style={{ fill: color }}
        aria-hidden="true"
      />
      <path className="ac-spark-line" d={path} style={{ stroke: color }} />
    </svg>
  );
}

export default Sparkline;
