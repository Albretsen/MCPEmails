import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELTA_DEAD_ZONE_PERCENT,
  GROWTH_METRICS,
  GROWTH_METRIC_KEYS,
  deltaTone,
  gmailCapProjection,
  isGrowthMetricKey,
  summariseSeries,
} from './growth-metrics.ts';

/** Every numeric column the SQL contract promises on GrowthDailyRow. */
const DAILY_COLUMNS = new Set([
  'new_workspaces',
  'technical_activations',
  'value_activations',
  'active_7d',
  'active_28d',
  'calls',
  'successes',
  'errors',
  'rate_limited',
]);

const finite = (summary) => {
  for (const [field, value] of Object.entries(summary)) {
    assert.equal(Number.isFinite(value), true, `${field} was ${value}`);
  }
};

test('an empty series summarises to zeroes rather than NaN', () => {
  const summary = summariseSeries([]);
  finite(summary);
  assert.deepEqual(summary, {
    current: 0, previous: 0, deltaAbsolute: 0, deltaPercent: 0, min: 0, max: 0, average: 0,
  });
});

test('a single point has no prior period to compare against', () => {
  const summary = summariseSeries([7]);
  finite(summary);
  assert.deepEqual(summary, {
    current: 7, previous: 0, deltaAbsolute: 7, deltaPercent: 0, min: 7, max: 7, average: 7,
  });
});

test('the series splits into two equal halves, dropping the oldest odd sample', () => {
  // 5 points, half = 2: current is [8, 12], previous is [2, 4], the leading 100
  // is deliberately ignored so both periods are the same length.
  const summary = summariseSeries([100, 2, 4, 8, 12]);
  assert.equal(summary.current, 10);
  assert.equal(summary.previous, 3);
  assert.equal(summary.deltaAbsolute, 7);
  assert.equal(summary.deltaPercent, 233.33);
  assert.equal(summary.min, 2);
  assert.equal(summary.max, 100);
  assert.equal(summary.average, 25.2);
});

test('a zero prior period gives a zero delta, never Infinity', () => {
  const summary = summariseSeries([0, 0, 5, 9]);
  finite(summary);
  assert.equal(summary.previous, 0);
  assert.equal(summary.deltaPercent, 0);
  assert.equal(summary.deltaAbsolute, 7);
});

test('an all-zero series stays finite', () => {
  finite(summariseSeries([0, 0, 0, 0]));
  assert.equal(summariseSeries([0, 0, 0, 0]).deltaPercent, 0);
});

test('non-finite samples are read as zero instead of poisoning the summary', () => {
  const summary = summariseSeries([Number.NaN, 4, Number.POSITIVE_INFINITY, 4]);
  finite(summary);
  assert.equal(summary.previous, 2);
  assert.equal(summary.current, 2);
  assert.equal(summary.min, 0);
  assert.equal(summary.max, 4);
});

test('a falling series reports a negative delta', () => {
  const summary = summariseSeries([10, 10, 5, 5]);
  assert.equal(summary.deltaAbsolute, -5);
  assert.equal(summary.deltaPercent, -50);
});

test('deltaTone colours by direction of good', () => {
  assert.equal(deltaTone(30, 'up'), 'good');
  assert.equal(deltaTone(30, 'down'), 'bad');
  assert.equal(deltaTone(-30, 'up'), 'bad');
  assert.equal(deltaTone(-30, 'down'), 'good');
});

test('deltaTone treats small movement as noise', () => {
  assert.equal(deltaTone(0, 'up'), 'neutral');
  assert.equal(deltaTone(1.9, 'up'), 'neutral');
  assert.equal(deltaTone(-1.9, 'down'), 'neutral');
  // The dead zone is exclusive at its edge: exactly 2 percent is coloured.
  assert.equal(deltaTone(DELTA_DEAD_ZONE_PERCENT, 'up'), 'good');
  assert.equal(deltaTone(-DELTA_DEAD_ZONE_PERCENT, 'up'), 'bad');
});

test('deltaTone never colours a non-finite delta', () => {
  assert.equal(deltaTone(Number.NaN, 'up'), 'neutral');
  assert.equal(deltaTone(Number.POSITIVE_INFINITY, 'up'), 'neutral');
});

test('every catalogue entry agrees with its own key and stays internally consistent', () => {
  for (const key of GROWTH_METRIC_KEYS) {
    const metric = GROWTH_METRICS[key];
    assert.equal(metric.key, key);
    assert.equal(typeof metric.label, 'string');
    assert.ok(metric.label.length > 0, `${key} has no label`);
    assert.ok(metric.definition.length > 40, `${key} needs a real definition`);
    assert.ok(['up', 'down'].includes(metric.goodDirection));
    assert.ok(['daily', 'window'].includes(metric.kind));
    assert.ok(['count', 'percent'].includes(metric.unit));
    assert.ok(['daily', 'monthly'].includes(metric.granularity));
    assert.ok(metric.target === null || Number.isFinite(metric.target));
    if (metric.column !== undefined) {
      assert.ok(DAILY_COLUMNS.has(metric.column), `${key} points at unknown column ${metric.column}`);
    }
  }
});

test('the derived and monthly metrics are the only exceptions', () => {
  assert.equal(GROWTH_METRICS.success_rate.unit, 'percent');
  assert.equal(GROWTH_METRICS.success_rate.column, undefined);
  assert.equal(GROWTH_METRICS.gmail_grants.granularity, 'monthly');
  assert.equal(GROWTH_METRICS.gmail_grants.column, undefined);
  for (const key of GROWTH_METRIC_KEYS) {
    if (key !== 'success_rate') assert.equal(GROWTH_METRICS[key].unit, 'count');
    if (key !== 'gmail_grants') assert.equal(GROWTH_METRICS[key].granularity, 'daily');
  }
});

test('isGrowthMetricKey rejects unknown keys and inherited properties', () => {
  assert.equal(isGrowthMetricKey('calls'), true);
  assert.equal(isGrowthMetricKey('workspace_id'), false);
  assert.equal(isGrowthMetricKey('toString'), false);
  assert.equal(isGrowthMetricKey('__proto__'), false);
});

const capRow = (overrides) => ({
  distinct_ever: 0,
  live: 0,
  active: 0,
  first_grant_at: null,
  grants_last_30d: 0,
  grants_last_60d: 0,
  google_reported_users: null,
  google_reported_at: null,
  ...overrides,
});

const NOW = new Date('2026-08-13T00:00:00Z');
const oldClient = '2025-01-01T00:00:00Z';

test('cap projection halves the 60 day count once the client is old enough', () => {
  const projection = gmailCapProjection(
    capRow({ distinct_ever: 40, first_grant_at: oldClient, grants_last_30d: 5, grants_last_60d: 12 }),
    NOW,
  );
  assert.equal(projection.used, 40);
  assert.equal(projection.cap, 100);
  assert.equal(projection.remaining, 60);
  assert.equal(projection.percent, 40);
  assert.equal(projection.ratePerMonth, 6);
  assert.equal(projection.projectedExhaustion, '2027-06'); // 10 months out
  assert.equal(projection.level, 'ok');
});

test('a client younger than 60 days uses the 30 day count instead', () => {
  const projection = gmailCapProjection(
    capRow({ distinct_ever: 10, first_grant_at: '2026-08-01T00:00:00Z', grants_last_30d: 9, grants_last_60d: 9 }),
    NOW,
  );
  assert.equal(projection.ratePerMonth, 9);
  assert.equal(projection.projectedExhaustion, '2027-06'); // 90 remaining / 9
});

test('a zero rate means no projection at all, not a date at infinity', () => {
  const projection = gmailCapProjection(capRow({ distinct_ever: 12, first_grant_at: oldClient }), NOW);
  assert.equal(projection.ratePerMonth, 0);
  assert.equal(projection.projectedExhaustion, null);
});

test('the hand-entered Google figure wins when it is higher than our floor', () => {
  const projection = gmailCapProjection(capRow({ distinct_ever: 55, google_reported_users: 71 }), NOW);
  assert.equal(projection.used, 71);
  assert.equal(projection.remaining, 29);
  assert.equal(projection.level, 'warn');
});

test('a stale Google figure never lowers the count below what we can see', () => {
  const projection = gmailCapProjection(capRow({ distinct_ever: 84, google_reported_users: 30 }), NOW);
  assert.equal(projection.used, 84);
  assert.equal(projection.level, 'danger');
});

test('cap levels sit on the documented thresholds', () => {
  assert.equal(gmailCapProjection(capRow({ distinct_ever: 59 }), NOW).level, 'ok');
  assert.equal(gmailCapProjection(capRow({ distinct_ever: 60 }), NOW).level, 'warn');
  assert.equal(gmailCapProjection(capRow({ distinct_ever: 79 }), NOW).level, 'warn');
  assert.equal(gmailCapProjection(capRow({ distinct_ever: 80 }), NOW).level, 'danger');
});

test('the aggregate decides what a period collapses to', () => {
  const series = [1, 2, 3, 4, 10, 20, 30, 40];
  // Sums: the card prints a window total for per-day counts, so the drawer must too.
  assert.deepEqual(
    [summariseSeries(series, 'sum').current, summariseSeries(series, 'sum').previous],
    [100, 10],
  );
  // Levels: a rolling window or a cumulative series is read at its endpoint.
  assert.deepEqual(
    [summariseSeries(series, 'last').current, summariseSeries(series, 'last').previous],
    [40, 4],
  );
  // Rates: neither a sum nor an endpoint describes a percentage over a period.
  assert.equal(summariseSeries(series, 'mean').current, 25);
  // Unspecified stays the mean, which is what the pre-existing callers assume.
  assert.equal(summariseSeries(series).current, summariseSeries(series, 'mean').current);
});

test('every metric declares how its period collapses', () => {
  for (const metric of Object.values(GROWTH_METRICS)) {
    assert.ok(
      ['sum', 'last', 'mean'].includes(metric.aggregate),
      `${metric.key} has no valid aggregate`,
    );
    // A rolling window summed over a period double-counts the same workspaces.
    if (metric.kind === 'window') assert.equal(metric.aggregate, 'last', metric.key);
    // A percentage is never a total.
    if (metric.unit === 'percent') assert.equal(metric.aggregate, 'mean', metric.key);
  }
});

test('a low count with a short runway still escalates', () => {
  // The real 2026-08-13 shape: 40 of 100 spent, but 35 grants in 60 days means
  // roughly 3.4 months of headroom. Verification plus CASA take weeks, so a
  // count-only rule reporting "ok" here would hide the whole point of the card.
  const projection = gmailCapProjection(
    capRow({ distinct_ever: 40, first_grant_at: oldClient, grants_last_60d: 35 }),
    NOW,
  );
  assert.equal(projection.ratePerMonth, 17.5);
  assert.equal(projection.level, 'warn');

  // Same count, twice the rate: under two months of runway, so danger.
  const faster = gmailCapProjection(
    capRow({ distinct_ever: 40, first_grant_at: oldClient, grants_last_60d: 70 }),
    NOW,
  );
  assert.equal(faster.level, 'danger');
});

test('an over-cap client reports no remaining slots and the current month', () => {
  const projection = gmailCapProjection(
    capRow({ distinct_ever: 118, first_grant_at: oldClient, grants_last_60d: 20 }),
    NOW,
  );
  assert.equal(projection.remaining, 0);
  assert.equal(projection.percent, 118);
  assert.equal(projection.projectedExhaustion, '2026-08');
  assert.equal(projection.level, 'danger');
});
