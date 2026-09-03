import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agoLabel,
  daysBetween,
  daysToTarget,
  formatDayKey,
  nextMilestone,
  recordDay,
  streak,
} from './growth-records.ts';

const day = (d: string, count: number) => ({ day: d, count });

test('a streak counts consecutive days ending at the last complete day', () => {
  const summary = streak([
    day('2026-08-28', 1),
    day('2026-08-29', 0),
    day('2026-08-30', 2),
    day('2026-08-31', 1),
    day('2026-09-01', 3),
    day('2026-09-02', 0), // today, still in progress
  ]);
  assert.equal(summary.current, 3);
  assert.equal(summary.todayCounts, false);
});

test('an unfinished day extends a streak but never ends one', () => {
  // The whole point: read at 00:30 UTC before the day's first signup, the naive
  // version reports a collapse to zero and repairs itself by lunchtime.
  const quietToday = streak([day('2026-09-01', 4), day('2026-09-02', 0)]);
  assert.equal(quietToday.current, 1);

  const busyToday = streak([day('2026-09-01', 4), day('2026-09-02', 1)]);
  assert.equal(busyToday.current, 2);
  assert.equal(busyToday.todayCounts, true);
});

test('the longest run is dated by its last day and includes a live one', () => {
  const summary = streak([
    day('2026-08-01', 1),
    day('2026-08-02', 1),
    day('2026-08-03', 1),
    day('2026-08-04', 0),
    day('2026-08-05', 1),
    day('2026-08-06', 1),
  ]);
  assert.equal(summary.longest, 3);
  assert.equal(summary.longestEndedOn, '2026-08-03');

  const live = streak([day('2026-08-05', 1), day('2026-08-06', 1), day('2026-08-07', 1)]);
  assert.equal(live.longest, 3);
  assert.equal(live.longestEndedOn, '2026-08-07');
});

test('an empty series has no streak rather than a phantom one', () => {
  assert.deepEqual(streak([]), { current: 0, longest: 0, longestEndedOn: null, todayCounts: false });
});

test('the record day breaks ties towards the more recent day', () => {
  const best = recordDay([day('2026-08-01', 9), day('2026-08-02', 4), day('2026-08-03', 9)]);
  assert.equal(best?.day, '2026-08-03');
  assert.equal(best?.count, 9);
});

test('an all-quiet series has no record day', () => {
  assert.equal(recordDay([day('2026-08-01', 0), day('2026-08-02', 0)]), null);
});

test('milestones land on numbers people celebrate, not the next multiple of a hundred', () => {
  assert.equal(nextMilestone(23)?.target, 25);
  assert.equal(nextMilestone(324)?.target, 500);
  assert.equal(nextMilestone(0)?.target, 1);
  assert.equal(nextMilestone(100)?.target, 250);
});

test('a milestone reports the distance and the share already covered', () => {
  const milestone = nextMilestone(400);
  assert.equal(milestone?.target, 500);
  assert.equal(milestone?.remaining, 100);
  assert.equal(Math.round(milestone?.percent ?? 0), 80);
});

test('pace refuses to forecast from a standstill', () => {
  assert.equal(daysToTarget(50, 0), null);
  assert.equal(daysToTarget(50, -2), null);
  assert.equal(daysToTarget(0, 0), 0);
  assert.equal(daysToTarget(50, 5), 10);
  // Beyond three years is not a forecast.
  assert.equal(daysToTarget(5000, 1), null);
});

test('day arithmetic and labels', () => {
  assert.equal(daysBetween('2026-09-01T00:00:00Z', '2026-09-03T12:00:00Z'), 2);
  assert.equal(agoLabel('2026-09-03T09:00:00Z', Date.parse('2026-09-03T18:00:00Z')), 'today');
  assert.equal(agoLabel('2026-09-02T09:00:00Z', Date.parse('2026-09-03T18:00:00Z')), 'yesterday');
  assert.equal(agoLabel('2026-08-22T09:00:00Z', Date.parse('2026-09-03T18:00:00Z')), '12 days ago');
  assert.equal(agoLabel(null), null);
});

test('day keys render in UTC regardless of the process timezone', () => {
  // Run under TZ=Pacific/Auckland this is 4 Sep locally, and a formatter that
  // did not pin UTC would say so. The month abbreviation itself is left to ICU
  // ("Sep" or "Sept" depending on the build) and is not what this asserts.
  assert.match(formatDayKey('2026-09-03') ?? '', /^3 Sept? 2026$/);
  assert.equal(formatDayKey('nonsense'), null);
  assert.equal(formatDayKey(null), null);
});
