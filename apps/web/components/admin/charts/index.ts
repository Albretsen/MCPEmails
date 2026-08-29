/**
 * index.ts: the public surface of the growth dashboard chart primitives.
 *
 * Import from this barrel, not from the individual files, so the internals
 * (Plot, the scale maths) stay free to move. Everything here is a Server
 * Component: rendering any of these charts ships zero client JavaScript.
 */

export { ChartFrame } from './ChartFrame';
export type { ChartFrameProps, ChartLegendItem, ChartTable } from './ChartFrame';

export { Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';

export { BarSeries } from './BarSeries';
export type { BarSeriesProps } from './BarSeries';
export type { BarDatum, SeriesSpec } from './data';

export { LineChart } from './LineChart';
export type { LineChartProps } from './LineChart';

export { ProgressMeter } from './ProgressMeter';
export type { ProgressMeterProps } from './ProgressMeter';

export { FunnelBars } from './FunnelBars';
export type { FunnelBarsProps, FunnelStep } from './FunnelBars';

export { CohortHeatmap } from './CohortHeatmap';
export type { CohortHeatmapProps, CohortRow } from './CohortHeatmap';

export { SERIES_COLORS, STATUS_COLORS, seriesColor } from './palette';
export type { StatusKey } from './palette';

export {
  MIN_DENOMINATOR_FOR_PERCENT,
  NO_DATA,
  clamp,
  formatCount,
  formatMoney,
  formatPercent,
  ratio,
  share,
} from './format';
