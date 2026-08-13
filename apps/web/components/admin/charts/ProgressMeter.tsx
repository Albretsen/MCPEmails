/**
 * ProgressMeter.tsx: a horizontal capacity bar for "how much of a hard limit
 * have we used".
 *
 * WHY it is its own component and not a styled div: the limits it tracks are
 * cliffs, not budgets. Google's unverified-app screen allows 100 user grants
 * and then Gmail connections simply stop working for everyone who has not
 * already granted. A bar that is merely blue at 40 and merely blue at 96 does
 * not tell anyone to go start the verification paperwork, so the fill colour
 * changes as it crosses the thresholds and the caption always spells out the
 * headroom left in plain counts.
 *
 * The bar is an SVG (two stretched rects) while every number is HTML beside
 * it, which keeps the type crisp at any card width.
 */

import { ChartFrame } from './ChartFrame';
import { clamp, formatCount, ratio, share, slugify } from './format';
import { STATUS_COLORS, type StatusKey } from './palette';

export type ProgressMeterProps = {
  value: number;
  max: number;
  label: string;
  /**
   * Fill is mint below `warn`, amber from `warn` up to `danger`, red at or
   * above `danger`. Values at or below 1 are read as fractions of `max`
   * (0.7 = seventy percent); anything larger is read as an absolute value in
   * the same units as `value`, so `{ warn: 60, danger: 80 }` against a cap of
   * 100 means what it looks like it means.
   */
  thresholds?: { warn: number; danger: number };
  /** Extra context under the bar, for example what happens when it fills. */
  note?: string;
  /** Units for the caption, for example "grants". Defaults to no unit. */
  unit?: string;
};

const DEFAULT_THRESHOLDS = { warn: 0.7, danger: 0.9 };

/** Turns either notation (fraction of max, or absolute value) into fractions. */
function asFractions(thresholds: { warn: number; danger: number }, max: number) {
  const one = (value: number) => (value > 1 ? share(value, max) : value);
  return { warn: one(thresholds.warn), danger: one(thresholds.danger) };
}

function statusFor(fraction: number, thresholds: { warn: number; danger: number }): StatusKey {
  if (fraction >= thresholds.danger) return 'danger';
  if (fraction >= thresholds.warn) return 'warn';
  return 'ok';
}

export function ProgressMeter({
  value,
  max,
  label,
  thresholds = DEFAULT_THRESHOLDS,
  note,
  unit,
}: ProgressMeterProps) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const fraction = share(safeValue, safeMax);
  const marks = asFractions(thresholds, safeMax);
  const status = statusFor(fraction, marks);
  const width = clamp(fraction * 100, 0, 100);
  const remaining = Math.max(0, safeMax - safeValue);
  const titleId = `ac-meter-${slugify(label)}`;
  const suffix = unit ? ` ${unit}` : '';

  const caption =
    safeMax === 0
      ? 'No limit configured.'
      : `${formatCount(safeValue)} of ${formatCount(safeMax)}${suffix} used, ${formatCount(remaining)} left.`;

  return (
    <ChartFrame title={label} subtitle={note}>
      <div className="ac-meter">
        <div className="ac-meter-value">
          <strong>{formatCount(safeValue)}</strong>
          <span className="ac-meter-of">{`of ${formatCount(safeMax)}${suffix}`}</span>
          <span className={`ac-pill ac-pill-${status}`}>{ratio(safeValue, safeMax)}</span>
        </div>

        <svg
          className="ac-meter-svg"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>{`${label}: ${caption}`}</title>
          <rect className="ac-meter-track" x="0" y="0" width="100" height="10" />
          {width > 0 ? (
            <rect
              className="ac-meter-fill"
              x="0"
              y="0"
              width={width}
              height="10"
              style={{ fill: STATUS_COLORS[status] }}
            />
          ) : null}
          {/* Threshold notches: the reader should see the cliff before hitting it. */}
          {safeMax > 0
            ? [marks.warn, marks.danger].map((mark) => (
                <line
                  className="ac-meter-mark"
                  key={mark}
                  x1={clamp(mark * 100, 0, 100)}
                  x2={clamp(mark * 100, 0, 100)}
                  y1="0"
                  y2="10"
                />
              ))
            : null}
        </svg>

        <p className="ac-meter-caption">{caption}</p>
      </div>
    </ChartFrame>
  );
}

export default ProgressMeter;
