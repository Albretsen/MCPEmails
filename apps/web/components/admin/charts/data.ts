/**
 * data.ts: normalizes the two shapes callers use to describe a time series.
 *
 * WHY two shapes: a chart is naturally described either row-wise ("here is
 * each day, and what every series did on it") or column-wise ("here are the
 * dates, and here is one array per series"). Query results arrive in the
 * second form, hand-written fixtures are easier to read in the first, and
 * arguing about it at the call site is not worth anyone's afternoon. Both are
 * accepted; everything downstream works on the normalized column form.
 *
 *   row-wise    : <BarSeries data={[{ label, values: [1, 2] }]} series={[a, b]} />
 *   column-wise : <BarSeries labels={[...]} series={[{ key, name, values }]} />
 */

export type BarDatum = {
  /** X-axis category, normally a short date such as "Jul 14". */
  label: string;
  /** One entry per series, positionally matched to the `series` prop. */
  values: number[];
};

export type SeriesSpec = {
  /** Stable React key, and the column key when values are supplied here. */
  key: string;
  /** Human label shown in the legend and the numbers table header. */
  name: string;
  /** Column-wise values. Ignored when the caller passes row-wise `data`. */
  values?: number[];
};

export type NormalizedPlot = { labels: string[]; columns: number[][] };

/** Anything non-numeric becomes 0 so no geometry ever receives NaN. */
function num(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

export function normalizePlotData(
  series: SeriesSpec[],
  data?: BarDatum[],
  labels?: string[],
): NormalizedPlot {
  if (data && data.length > 0) {
    return {
      labels: data.map((datum) => datum.label),
      columns: series.map((_spec, index) => data.map((datum) => num(datum.values?.[index]))),
    };
  }

  const raw = series.map((spec) => spec.values ?? []);
  const length = labels?.length ?? raw.reduce((longest, column) => Math.max(longest, column.length), 0);
  // Without labels the x axis still has to say something, so fall back to
  // one-based positions rather than rendering a blank axis.
  const resolved = labels?.length ? labels.slice(0, length) : Array.from({ length }, (_, i) => String(i + 1));
  return {
    labels: resolved,
    columns: raw.map((column) => Array.from({ length }, (_, i) => num(column[i]))),
  };
}
