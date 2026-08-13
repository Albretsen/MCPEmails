/**
 * FunnelBars.tsx: a horizontal funnel, one row per step.
 *
 * WHY every row carries three numbers: a funnel drawn as bars alone answers
 * "where do people stop" only if you can already see the drop, and on a
 * product with roughly 116 workspaces the interesting drops are between
 * single-digit numbers that look identical at this scale. So each row states
 * the absolute count, the conversion from the step directly above it (which
 * is the number that tells you where to work), and the conversion from the top
 * of the funnel (which is the number that tells you whether it matters).
 *
 * Both derived numbers go through `ratio()`, so a step that converted 3 of 7
 * says exactly that instead of claiming a 43% conversion rate.
 *
 * Bars are stretched SVG rects; every label is HTML, so the type stays the
 * same size in a 320px card and a 1400px one.
 */

import { ChartFrame, type ChartTable } from './ChartFrame';
import { clamp, formatCount, ratio, share, slugify } from './format';
import { SERIES_COLORS } from './palette';

/* Every step is the same colour on purpose. Walking the series palette down a
   funnel paints the last, smallest step red, which reads as an alarm about a
   step that is merely late in the sequence. The rows are already labelled. */
const STEP_COLOR = SERIES_COLORS[0];

export type FunnelStep = {
  label: string;
  value: number;
  /** Optional aside, for example the definition of the step. */
  note?: string;
};

export type FunnelBarsProps = {
  /** Omit when the surrounding section already carries the heading. */
  title?: string;
  subtitle?: string;
  steps: FunnelStep[];
  footnote?: string;
};

export function FunnelBars({ title, subtitle, steps, footnote }: FunnelBarsProps) {
  if (steps.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
        <p className="ac-empty">No funnel steps configured.</p>
      </ChartFrame>
    );
  }

  const clean = steps.map((step) => ({
    ...step,
    value: Number.isFinite(step.value) ? Math.max(0, step.value) : 0,
  }));
  const top = clean[0].value;

  const table: ChartTable = {
    columns: ['Step', 'Count', 'From previous', 'From top'],
    rows: clean.map((step, index) => [
      step.label,
      formatCount(step.value),
      index === 0 ? '' : ratio(step.value, clean[index - 1].value),
      index === 0 ? '' : ratio(step.value, top),
    ]),
  };

  return (
    <ChartFrame title={title} subtitle={subtitle} table={table} footnote={footnote}>
      <ol className="ac-funnel">
        {clean.map((step, index) => {
          // Width is always measured against the top of the funnel, never
          // against the previous step, so a wide bar means "a lot of people"
          // rather than "a good conversion from a step that was already tiny".
          const width = clamp(share(step.value, top) * 100, 0, 100);
          const titleId = `ac-funnel-${slugify(title ?? 'steps')}-${index}`;
          return (
            <li className="ac-funnel-step" key={`${step.label}-${index}`}>
              <div className="ac-funnel-head">
                <span className="ac-funnel-label">{step.label}</span>
                <span className="ac-funnel-count">{formatCount(step.value)}</span>
              </div>

              <svg
                className="ac-funnel-svg"
                viewBox="0 0 100 12"
                preserveAspectRatio="none"
                role="img"
                aria-labelledby={titleId}
              >
                <title id={titleId}>
                  {index === 0
                    ? `${step.label}: ${formatCount(step.value)}, the top of the funnel.`
                    : `${step.label}: ${formatCount(step.value)}, ${ratio(step.value, clean[index - 1].value)} of the previous step and ${ratio(step.value, top)} of the top.`}
                </title>
                <rect className="ac-funnel-track" x="0" y="0" width="100" height="12" />
                {width > 0 ? (
                  <rect
                    className="ac-funnel-fill"
                    x="0"
                    y="0"
                    width={width}
                    height="12"
                    style={{ fill: STEP_COLOR }}
                  />
                ) : null}
              </svg>

              <div className="ac-funnel-meta">
                {index === 0 ? (
                  <span className="ac-funnel-stat">Top of funnel</span>
                ) : (
                  <>
                    <span className="ac-funnel-stat">
                      <span className="ac-funnel-stat-key">from previous</span>
                      {ratio(step.value, clean[index - 1].value)}
                    </span>
                    <span className="ac-funnel-stat">
                      <span className="ac-funnel-stat-key">from top</span>
                      {ratio(step.value, top)}
                    </span>
                  </>
                )}
                {step.note ? <span className="ac-funnel-note">{step.note}</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}

export default FunnelBars;
