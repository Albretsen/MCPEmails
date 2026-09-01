/**
 * Tests for the kiosk's calendar-week bucketing.
 *
 * WHY THIS FILE EXISTS AND THE REST OF THE BOARD HAS NO TESTS. Nearly
 * everything on the kiosk is a number fetched from SQL and printed; a test of
 * that is a test of a mock. This one function is real arithmetic with two
 * classic ways to be silently wrong, and it is arithmetic a wall display shows
 * as a chart somebody will make a decision from.
 *
 * The two ways:
 *
 *   1. `getUTCDay()` is 0 for SUNDAY. Every implementation of "the Monday of
 *      this week" that subtracts `getUTCDay() - 1` is correct for six days a
 *      week and puts Sunday in the wrong week on the seventh. The bug is
 *      invisible unless somebody looks at the board on a Sunday, which for a
 *      panel in an office is close to never.
 *
 *   2. Local time. `new Date('2026-09-01')` is midnight UTC but
 *      `new Date(2026, 8, 1)` is midnight wherever the server happens to be,
 *      and Vercel is UTC while this Mac is Europe/Oslo. A week boundary that
 *      moves by an hour is a signup that hops between two bars depending on
 *      where the page rendered.
 *
 * Run with: npm run --prefix apps/web test:kiosk
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarWeekBuckets, mondayOf } from './shared.ts';

test('mondayOf returns the Monday on or before a day, Sunday included', () => {
  // 2026-08-31 is a Monday. Walk the whole week and assert every day maps back
  // to it, which is the only form of this test that catches the Sunday bug.
  const week = [
    ['2026-08-31', 'Mon'],
    ['2026-09-01', 'Tue'],
    ['2026-09-02', 'Wed'],
    ['2026-09-03', 'Thu'],
    ['2026-09-04', 'Fri'],
    ['2026-09-05', 'Sat'],
    ['2026-09-06', 'Sun'],
  ] as const;
  for (const [day, name] of week) {
    assert.equal(mondayOf(day), '2026-08-31', `${name} ${day} belongs to the week of 31 Aug`);
  }
  // And the day after that Sunday starts a new week rather than extending it.
  assert.equal(mondayOf('2026-09-07'), '2026-09-07');
  // A Monday is its own Monday: no off-by-seven from an unconditional subtract.
  assert.equal(mondayOf('2026-08-24'), '2026-08-24');
});

test('buckets are Monday to Sunday and the current week is flagged partial', () => {
  // One row per day for three full weeks plus two days of a fourth, each
  // carrying a value of 1 so a correct bucket sums to the number of days in it.
  const rows: { day: string; n: number }[] = [];
  for (const day of daysBetween('2026-08-10', '2026-09-01')) rows.push({ day, n: 1 });

  const buckets = calendarWeekBuckets(rows, 8, (row) => [row.n], '2026-09-01');

  assert.deepEqual(
    buckets.map((bucket) => bucket.label),
    ['10 Aug', '17 Aug', 'Last week', 'This week'],
  );
  // Three complete weeks of seven, then Monday and Tuesday of the current one.
  assert.deepEqual(buckets.map((bucket) => bucket.values[0]), [7, 7, 7, 2]);
  assert.deepEqual(
    buckets.map((bucket) => bucket.partial === true),
    [false, false, false, true],
  );
});

test('a week with no rows at all is dropped, not rendered as zero', () => {
  // Asking for eight weeks against three weeks of data must not invent five
  // empty bars: on a wall, "nothing happened" and "we have no data" are
  // different facts and the second one is a bug report.
  const rows = daysBetween('2026-08-17', '2026-09-01').map((day) => ({ day, n: 2 }));
  const buckets = calendarWeekBuckets(rows, 8, (row) => [row.n], '2026-09-01');
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].label, '17 Aug');
});

test('a genuinely empty week INSIDE the range is kept at zero', () => {
  // The complement of the test above, and the reason the rule is "no rows"
  // rather than "no value": a week where nobody signed up is a finding and must
  // stay on the chart as a gap in the bars.
  const rows = [
    ...daysBetween('2026-08-17', '2026-08-23').map((day) => ({ day, n: 3 })),
    ...daysBetween('2026-08-24', '2026-08-30').map((day) => ({ day, n: 0 })),
    ...daysBetween('2026-08-31', '2026-09-01').map((day) => ({ day, n: 1 })),
  ];
  const buckets = calendarWeekBuckets(rows, 8, (row) => [row.n], '2026-09-01');
  assert.deepEqual(buckets.map((bucket) => bucket.values[0]), [21, 0, 2]);
});

test('every series in a row is summed independently', () => {
  const rows = daysBetween('2026-08-31', '2026-09-01').map((day, index) => ({
    day,
    a: index + 1,
    b: (index + 1) * 10,
  }));
  const buckets = calendarWeekBuckets(rows, 2, (row) => [row.a, row.b], '2026-09-01');
  assert.deepEqual(buckets, [{ label: 'This week', values: [3, 30], partial: true }]);
});

test('an ISO timestamp is accepted where a day key is expected', () => {
  // The RPC returns `day` as a date, but PostgREST has handed back full
  // timestamps before on other columns and the board must not silently bucket
  // every one of them into the epoch week if it ever does again.
  const buckets = calendarWeekBuckets(
    [{ day: '2026-08-31T00:00:00+00:00', n: 5 }],
    2,
    (row) => [row.n],
    '2026-09-01',
  );
  assert.deepEqual(buckets, [{ label: 'This week', values: [5], partial: true }]);
});

test('no rows produces no buckets rather than eight empty ones', () => {
  assert.deepEqual(calendarWeekBuckets([] as { day: string }[], 8, () => [0]), []);
});

/** Inclusive UTC day keys from one date to another. */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00Z`);
    time <= Date.parse(`${to}T00:00:00Z`);
    time += 86_400_000
  ) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}
