import test from 'node:test';
import assert from 'node:assert/strict';
import { completedWeeks, signupTrend, trendState, type SignupTrendRow } from './signup-trend.ts';

const AS_OF = '2026-10-19T09:19:34Z';

/** Rows from completed weekly counts plus a current week, Mondays from 2026-07-27. */
function rows(completed: number[], current = { soFar: 5 }, byNow?: number[]): SignupTrendRow[] {
  const start = Date.UTC(2026, 6, 27);
  const all = [...completed, current.soFar];
  return all.map((count, index) => ({
    week_start: new Date(start + index * 7 * 86_400_000).toISOString().slice(0, 10),
    workspaces: count,
    by_now: index === completed.length ? count : (byNow?.[index] ?? 0),
    as_of: AS_OF,
  }));
}

const weeks = (counts: number[]) =>
  completedWeeks(counts.map((count, index) => ({ weekStart: `2026-08-${String(index + 1).padStart(2, '0')}`, count })));

test('the production series on 2026-10-19 reads OK: a flat week is not a fall', () => {
  const trend = signupTrend(rows([17, 25, 46, 62, 83, 107, 120, 148, 158, 211, 258, 264]));
  assert.equal(trend.state, 'ok');
  assert.equal(trend.weeks.length, 8);
  assert.equal(trend.weeks[7].count, 264);
  // 148, 158, 211, 258
  assert.equal(trend.weeks[7].baseline, 193.75);
  assert.equal(Math.round(trend.weekOverWeek ?? 0), 2);
});

test('one completed week below the trailing average is WATCH', () => {
  assert.equal(trendState(weeks([100, 100, 100, 100, 99])).state, 'watch');
});

test('equal to the trailing average is not below it', () => {
  assert.equal(trendState(weeks([100, 100, 100, 100, 100])).state, 'ok');
});

test('two consecutive completed weeks below their averages is ALARM', () => {
  // Week 5: 95 vs 100. Week 6: 94 vs avg(100,100,100,95) = 98.75.
  const state = trendState(weeks([100, 100, 100, 100, 95, 94]));
  assert.equal(state.state, 'alarm');
  assert.match(state.headline, /two weeks/);
});

test('a dip that recovered is OK, not WATCH', () => {
  assert.equal(trendState(weeks([100, 100, 100, 100, 90, 120])).state, 'ok');
});

test('one week more than 20% below the trailing average is ALARM on its own', () => {
  const state = trendState(weeks([100, 100, 100, 100, 79]));
  assert.equal(state.state, 'alarm');
  assert.match(state.reason, /-21%/);
});

test('exactly 20% below is WATCH, not ALARM', () => {
  assert.equal(trendState(weeks([100, 100, 100, 100, 80])).state, 'watch');
});

test('fewer than five completed weeks cannot be judged', () => {
  assert.equal(trendState(weeks([100, 100, 100, 100])).state, 'unknown');
  assert.equal(trendState([]).state, 'unknown');
});

test('a collapsed partial week never moves the state', () => {
  // Monday morning, 0 so far against healthy completed weeks.
  const trend = signupTrend(rows([100, 110, 120, 130, 140, 150], { soFar: 0 }));
  assert.equal(trend.state, 'ok');
  assert.equal(trend.current?.soFar, 0);
});

test('the current week is compared with the same point in the previous four weeks', () => {
  const trend = signupTrend(rows([100, 110, 120, 130, 140, 150], { soFar: 30 }, [5, 5, 10, 20, 30, 40]));
  assert.deepEqual(
    trend.current?.samePoint.map((entry) => entry.count),
    [10, 20, 30, 40],
  );
  assert.equal(trend.current?.samePointAvg, 25);
  assert.equal(trend.current?.vsSamePoint, 20);
});

test('the last row is the current week even when rows arrive unordered', () => {
  const trend = signupTrend(rows([100, 100, 100, 100, 50], { soFar: 7 }).reverse());
  assert.equal(trend.state, 'alarm');
  assert.equal(trend.current?.soFar, 7);
  assert.equal(trend.weeks[trend.weeks.length - 1].count, 50);
});
