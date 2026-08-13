/**
 * BarSeries.tsx: vertical bars over a date axis, grouped or stacked, with an
 * optional line drawn over the top.
 *
 * WHY bars rather than a line for these metrics: signups, first successful
 * calls and paywall hits are counts of discrete events, and most days the
 * count is a single digit or zero. A line drawn through that implies a
 * continuous quantity that was never measured, and worse, it makes a day with
 * no events look like a dip rather than a gap. Bars say "this many happened".
 *
 * WHY the `overlay` prop: daily counts at this volume are extremely noisy, and
 * a smoothed line on top is the honest way to show the trend, because the raw
 * bars stay visible underneath it. A moving average that REPLACES the data is
 * how you end up believing in a trend that is three people.
 *
 * The x axis is deliberately sparse (about one label a week over 90 days).
 * Ninety date labels in a 690px card is a grey smear, and the exact date for
 * any given bar is in the numbers table and in the bar's own hover tooltip.
 */

import { ChartFrame, type ChartTable } from './ChartFrame';
import { Plot, tickAt, type XTick, type YTick } from './Plot';
import { normalizePlotData, type BarDatum, type SeriesSpec } from './data';
import { formatCount, slugify } from './format';
import { seriesColor } from './palette';
import { axisFrom, bandCenter, defaultTickEvery, linePath, tickIndices, toY, VIEW } from './scale';

export type { BarDatum, SeriesSpec } from './data';

export type BarSeriesProps = {
  title: string;
  subtitle?: string;
  /** Row-wise data. Alternatively pass `labels` plus values on each series. */
  data?: BarDatum[];
  /** Column-wise x categories, used when the series carry their own values. */
  labels?: string[];
  series: SeriesSpec[];
  /** Stack the series into one bar per date instead of standing them side by side. */
  stacked?: boolean;
  /** Series drawn as lines on top of the bars, for example a 7 day average. */
  overlay?: SeriesSpec[];
  /** Plot height in CSS pixels. Default 200. */
  height?: number;
  /** Label every Nth date. Defaults to roughly thirteen labels across the range. */
  tickEvery?: number;
  footnote?: string;
};

export function BarSeries({
  title,
  subtitle,
  data,
  labels: labelsProp,
  series,
  stacked = false,
  overlay,
  height = 200,
  tickEvery,
  footnote,
}: BarSeriesProps) {
  const { labels, columns } = normalizePlotData(series, data, labelsProp);
  const overlaySpecs = overlay ?? [];
  const overlayColumns = normalizePlotData(overlaySpecs, undefined, labels).columns;
  const count = labels.length;
  const titleId = `ac-bars-${slugify(title)}`;

  if (count === 0 || series.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
        <p className="ac-empty">No data in this window.</p>
      </ChartFrame>
    );
  }

  const at = (seriesIndex: number, index: number) => Math.max(0, columns[seriesIndex][index] ?? 0);
  const totalAt = (index: number) => series.reduce((sum, _spec, i) => sum + at(i, index), 0);

  const peak = Math.max(
    ...labels.map((_label, index) =>
      stacked ? totalAt(index) : series.reduce((highest, _spec, i) => Math.max(highest, at(i, index)), 0),
    ),
    ...overlayColumns.flatMap((column) => column),
  );

  const axis = axisFrom(peak, 4);
  const yTicks: YTick[] = axis.ticks.map((value) => ({ value, label: formatCount(value), y: toY(value, axis.max) }));

  const every = tickEvery && tickEvery > 0 ? tickEvery : defaultTickEvery(count);
  const labelled = tickIndices(count, every);
  const xTicks: XTick[] = labelled.map((index) => tickAt(index, labels[index], bandCenter(index, count)));

  const band = VIEW / count;
  // Leave a sliver of air between bands. Below about four pixels of rendered
  // bar the gap stops reading as separation and just eats the bar, so the
  // fraction is generous rather than clever.
  const bandWidth = band * 0.76;
  const slotWidth = stacked ? bandWidth : bandWidth / series.length;
  const showTotal = stacked && series.length > 1;

  const table: ChartTable = {
    columns: [
      'Date',
      ...series.map((spec) => spec.name),
      ...(showTotal ? ['Total'] : []),
      ...overlaySpecs.map((spec) => spec.name),
    ],
    rows: labels.map((label, index) => [
      label,
      ...series.map((_spec, i) => formatCount(at(i, index))),
      ...(showTotal ? [formatCount(totalAt(index))] : []),
      ...overlaySpecs.map((_spec, i) => (overlayColumns[i][index] ?? 0).toFixed(1)),
    ]),
  };

  const legend = [
    ...series.map((spec, index) => ({
      name: spec.name,
      color: seriesColor(index),
      note: formatCount(labels.reduce((sum, _label, i) => sum + at(index, i), 0)),
    })),
    ...overlaySpecs.map((spec, index) => ({ name: spec.name, color: seriesColor(series.length + index) })),
  ];

  const grandTotal = labels.reduce((sum, _label, index) => sum + totalAt(index), 0);
  const plotTitle = `${title}: ${series.map((spec) => spec.name).join(', ')} across ${count} points, ${formatCount(grandTotal)} events in total, busiest point ${formatCount(peak)}.`;

  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} table={table} footnote={footnote}>
      <Plot height={height} yTicks={yTicks} xTicks={xTicks} titleId={titleId} title={plotTitle}>
        {labels.map((label, index) => {
          const left = index * band + (band - bandWidth) / 2;
          let stackTop = VIEW;
          return (
            <g key={`${label}-${index}`}>
              {series.map((spec, seriesIndex) => {
                const value = at(seriesIndex, index);
                const top = toY(value, axis.max);
                const barHeight = VIEW - top;
                const x = stacked ? left : left + seriesIndex * slotWidth;
                const y = stacked ? stackTop - barHeight : top;
                if (stacked) stackTop -= barHeight;
                // Zero-height rects are dropped: an invisible mark still takes
                // hover area and stacks up meaningless tooltips.
                if (barHeight <= 0) return null;
                return (
                  <rect
                    className="ac-bar"
                    key={spec.key}
                    x={x}
                    y={y}
                    width={slotWidth}
                    height={barHeight}
                    style={{ fill: seriesColor(seriesIndex) }}
                  >
                    <title>{`${label}, ${spec.name}: ${formatCount(value)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {overlaySpecs.map((spec, index) => (
          <path
            className="ac-line ac-line-overlay"
            key={spec.key}
            d={linePath(
              labels.map((_label, i) => ({
                x: bandCenter(i, count),
                y: toY(overlayColumns[index][i] ?? 0, axis.max),
              })),
            )}
            style={{ stroke: seriesColor(series.length + index) }}
          />
        ))}
      </Plot>
    </ChartFrame>
  );
}

export default BarSeries;
