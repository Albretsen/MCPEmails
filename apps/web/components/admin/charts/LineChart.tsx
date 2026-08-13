/**
 * LineChart.tsx: one or more lines over a date axis, with an optional
 * dashed limit rule.
 *
 * WHY the threshold prop exists: the metric this page most needs to watch is
 * the Gmail unverified-app grant counter, which is capped at 100 users and
 * simply stops working when it is reached. A cap like that is not a data
 * series, it is a wall, and a chart that draws it as another line invites the
 * reader to treat it as one more wiggle. It renders as a dashed rule with its
 * own label, and it is always included in the y-axis range so it cannot fall
 * off the top of the picture and be quietly forgotten.
 *
 * No point markers: the SVG is stretched horizontally to fit its container, so
 * a circle would render as an ellipse of varying eccentricity. Values are in
 * the per-date hover strips and in the numbers table.
 */

import { ChartFrame, type ChartTable } from './ChartFrame';
import { Plot, tickAt, type XTick, type YTick } from './Plot';
import { normalizePlotData, type BarDatum, type SeriesSpec } from './data';
import { formatCount, slugify } from './format';
import { seriesColor } from './palette';
import { axisFrom, bandCenter, defaultTickEvery, linePath, pointX, tickIndices, toY, VIEW } from './scale';

export type LineChartProps = {
  title: string;
  subtitle?: string;
  /** Row-wise data. Alternatively pass `labels` plus values on each series. */
  data?: BarDatum[];
  /** Column-wise x categories, used when the series carry their own values. */
  labels?: string[];
  series: SeriesSpec[];
  /** A hard limit drawn as a dashed rule, for example the Gmail 100-user cap. */
  threshold?: { value: number; label: string };
  /**
   * `percent` means the values are already scaled 0..100 (a retention curve,
   * not a fraction). It suffixes the axis and pins the top of the scale to 100
   * so two percentage charts side by side are actually comparable.
   */
  unit?: 'count' | 'percent';
  /** Plot height in CSS pixels. Default 220. */
  height?: number;
  /** Label every Nth date. Defaults to roughly thirteen labels across the range. */
  tickEvery?: number;
  footnote?: string;
};

export function LineChart({
  title,
  subtitle,
  data,
  labels: labelsProp,
  series,
  threshold,
  unit = 'count',
  height = 220,
  tickEvery,
  footnote,
}: LineChartProps) {
  const { labels, columns } = normalizePlotData(series, data, labelsProp);
  const count = labels.length;
  const titleId = `ac-line-${slugify(title)}`;

  if (count === 0 || series.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
        <p className="ac-empty">No data in this window.</p>
      </ChartFrame>
    );
  }

  const at = (seriesIndex: number, index: number) => columns[seriesIndex][index] ?? 0;
  const format = (value: number) => (unit === 'percent' ? `${Math.round(value)}%` : formatCount(value));

  const observedPeak = Math.max(
    ...columns.flatMap((column) => column),
    threshold ? threshold.value : 0,
  );
  const axis = unit === 'percent' ? { max: 100, ticks: [0, 25, 50, 75, 100] } : axisFrom(observedPeak, 4);
  const yTicks: YTick[] = axis.ticks.map((value) => ({ value, label: format(value), y: toY(value, axis.max) }));

  const every = tickEvery && tickEvery > 0 ? tickEvery : defaultTickEvery(count);
  const labelled = tickIndices(count, every);
  const xTicks: XTick[] = labelled.map((index) => tickAt(index, labels[index], pointX(index, count)));

  const thresholdY = threshold ? toY(threshold.value, axis.max) : 0;
  const lastIndex = count - 1;

  const table: ChartTable = {
    columns: ['Point', ...series.map((spec) => spec.name)],
    rows: labels.map((label, index) => [label, ...series.map((_spec, i) => format(at(i, index)))]),
  };

  const legend = [
    ...series.map((spec, index) => ({
      name: spec.name,
      color: seriesColor(index),
      note: format(at(index, lastIndex)),
    })),
    ...(threshold
      ? [{ name: threshold.label, color: 'var(--red-500)', note: format(threshold.value), dashed: true }]
      : []),
  ];

  const latest = series.map((spec, index) => `${spec.name} ${format(at(index, lastIndex))}`).join(', ');
  const plotTitle = `${title}: ${count} points ending ${labels[lastIndex]}. Latest ${latest}.${
    threshold ? ` Limit ${threshold.label} at ${format(threshold.value)}.` : ''
  }`;

  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} table={table} footnote={footnote}>
      <Plot
        height={height}
        yTicks={yTicks}
        xTicks={xTicks}
        titleId={titleId}
        title={plotTitle}
        overlay={
          threshold ? (
            <span className="ac-threshold-tag" style={{ top: `${thresholdY}%` }}>
              {threshold.label}
            </span>
          ) : null
        }
      >
        {series.map((spec, seriesIndex) => (
          <path
            className="ac-line"
            key={spec.key}
            d={linePath(labels.map((_label, index) => ({ x: pointX(index, count), y: toY(at(seriesIndex, index), axis.max) })))}
            style={{ stroke: seriesColor(seriesIndex) }}
          />
        ))}

        {threshold ? (
          <line className="ac-threshold" x1="0" x2={VIEW} y1={thresholdY} y2={thresholdY} aria-hidden="true" />
        ) : null}

        {/* Invisible full-height strips give every date a native hover tooltip
            without a single line of client JavaScript. */}
        {labels.map((label, index) => (
          <rect
            className="ac-hit"
            key={`hit-${index}`}
            x={Math.max(0, bandCenter(index, count) - VIEW / count / 2)}
            y="0"
            width={VIEW / count}
            height={VIEW}
          >
            <title>{`${label}: ${series.map((spec, i) => `${spec.name} ${format(at(i, index))}`).join(', ')}`}</title>
          </rect>
        ))}
      </Plot>
    </ChartFrame>
  );
}

export default LineChart;
