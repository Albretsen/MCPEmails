/**
 * Drill-down series behind a clickable metric card on /admin/growth.
 *
 * The cards show one number. The question an operator actually has when they
 * look at that number is "what did it do to get here", and answering it by
 * loading a second full page of aggregates would undo the point of the cached
 * layer. This route serves just the one series, from the same cached fetchers
 * the page already used, so opening a drawer is normally free.
 *
 * Definitions come from GROWTH_METRICS rather than being written again here.
 * A card and its drawer describing the same number differently is exactly the
 * failure the catalogue exists to prevent.
 *
 * Aggregates only. Nothing on this route may identify a workspace: it is a
 * reporting surface, not an admin lookup tool.
 *
 * Not `force-dynamic`. It reads cookies through requireAdmin, so it is dynamic
 * already, and the fetchers underneath carry their own cache.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  GROWTH_METRICS,
  isGrowthMetricKey,
  summariseSeries,
  type GrowthMetric,
} from '@/lib/analytics/growth-metrics';
import { fetchDailyMetrics, fetchGmailGrantSeries } from '@/lib/analytics/growth-queries';
import type { GrowthDailyRow } from '@/lib/analytics/growth-types';

/**
 * Allowlist, not a parsed integer: the value reaches an RPC argument, and an
 * allowlist is the one validation that cannot be argued with later.
 */
const WINDOWS = { '28d': 28, '90d': 90 } as const;
const DEFAULT_WINDOW: keyof typeof WINDOWS = '90d';

/**
 * The Gmail grant series is monthly and cumulative in meaning: the cap it feeds
 * counts every grant ever given, so truncating it to the caller's day window
 * would hide the thing the chart exists to show. The full history is returned
 * and `granularity: 'monthly'` says so. The bound is a payload guard, not a
 * window, and at the current rate it is decades away from biting.
 */
const MAX_GRANT_MONTHS = 36;

type MetricPoint = { day: string; value: number };

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Both `date` and `timestamptz` serialise to a string starting YYYY-MM-DD. */
function dayKey(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function dailyValue(metric: GrowthMetric, row: GrowthDailyRow): number {
  if (metric.key === 'success_rate') {
    // Derived, not stored. A day with no calls is 0 percent rather than a
    // division by zero, and the drawer states that in the definition.
    const calls = numeric(row.calls);
    if (calls <= 0) return 0;
    return Math.round((numeric(row.successes) / calls) * 10_000) / 100;
  }
  return metric.column ? numeric(row[metric.column]) : 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  // notFound() rather than a 403: this endpoint's existence is not something a
  // non-admin should be able to confirm. Inside a route handler Next turns it
  // into a bare 404 Response with an empty body, which is what we want.
  await requireAdmin();

  const { key } = await params;
  if (!isGrowthMetricKey(key)) {
    return NextResponse.json({ error: 'Unknown metric.' }, { status: 404 });
  }
  const metric = GROWTH_METRICS[key];

  const requested = request.nextUrl.searchParams.get('window') ?? DEFAULT_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(WINDOWS, requested)) {
    return NextResponse.json({ error: 'Unsupported window. Use 28d or 90d.' }, { status: 400 });
  }
  const days = WINDOWS[requested as keyof typeof WINDOWS];

  let points: MetricPoint[];
  if (metric.granularity === 'monthly') {
    const series = await fetchGmailGrantSeries();
    if (!series.ok) return NextResponse.json({ error: series.error }, { status: 503 });
    // Cumulative, not per-month: the cap counts every grant ever given, so the
    // running total against the 100 rule is the only reading that answers the
    // question the drawer is opened to ask.
    points = series.data
      .map((row) => ({ day: dayKey(row.month), value: numeric(row.cumulative_grants) }))
      .filter((point) => point.day.length === 10)
      // Sorted here rather than trusting row order, same stance the contract
      // takes with stage_index.
      .sort((left, right) => left.day.localeCompare(right.day))
      .slice(-MAX_GRANT_MONTHS);
  } else {
    const daily = await fetchDailyMetrics(days);
    if (!daily.ok) return NextResponse.json({ error: daily.error }, { status: 503 });
    points = daily.data
      .map((row) => ({ day: dayKey(row.day), value: dailyValue(metric, row) }))
      .filter((point) => point.day.length === 10)
      .sort((left, right) => left.day.localeCompare(right.day));
  }

  return NextResponse.json({
    key: metric.key,
    label: metric.label,
    definition: metric.definition,
    goodDirection: metric.goodDirection,
    target: metric.target,
    threshold: metric.threshold,
    unit: metric.unit,
    granularity: metric.granularity,
    points,
    summary: summariseSeries(points.map((point) => point.value), metric.aggregate),
  });
}
