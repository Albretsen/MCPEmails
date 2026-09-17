import test from 'node:test';
import assert from 'node:assert/strict';
import type { CashCollected, CheckoutFunnel } from './kiosk-revenue.ts';
import type { GrowthDailyRow, GrowthLifecycleRow, GrowthUserSignupDayRow } from './growth-types.ts';
import type { RevenueSummary } from './revenue-math.ts';
import {
  ACHIEVEMENT_COUNT,
  achievementReport,
  type Achievement,
  type AchievementInput,
} from './growth-achievements.ts';
import { MILESTONE_UNLOCK_RECORD, type MilestoneUnlockRecord } from './growth-milestone-record.ts';

/*
 * The fixture is the real business on 2026-09-03, because a ladder tested only
 * against round numbers is a ladder nobody has checked at the height it is
 * actually standing at: $35 MRR, $250 collected, 6 customers, 339 signups, 169
 * ever activated, 115 active this week, 165,031 calls, a 32 day signup streak.
 */
const NOW = Date.parse('2026-09-03T12:00:00Z');
const TODAY = Date.parse('2026-09-03T00:00:00Z');
const WINDOW_DAYS = 90;

/** `offset` is days BEFORE today, so 0 is today and 89 is the oldest row. */
const dayKey = (offset: number) => new Date(TODAY - offset * 86_400_000).toISOString().slice(0, 10);

/**
 * 90 gapless days ending today. Three signups a day except 32 days ago, which
 * is what makes the current streak exactly 32, one twelve-signup spike 45 days
 * back to give the record-day ladder something real to read, and a cumulative
 * column that starts below 100 so the 100 and 250 rungs are crossed INSIDE the
 * window and can therefore be dated.
 */
function signupSeries(): GrowthUserSignupDayRow[] {
  const rows: GrowthUserSignupDayRow[] = [];
  let cumulative = 63;
  for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const newUsers = offset === 32 ? 0 : offset === 45 ? 12 : 3;
    cumulative += newUsers;
    rows.push({
      day: dayKey(offset),
      new_users: newUsers,
      activated_users: 1,
      cumulative_users: cumulative,
    });
  }
  return rows;
}

/** 90 days of traffic summing to exactly 165,031 calls, every day successful. */
function dailySeries(): GrowthDailyRow[] {
  const rows: GrowthDailyRow[] = [];
  for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const calls = offset === 0 ? 1_805 : 1_834;
    rows.push({
      day: dayKey(offset),
      new_workspaces: 3,
      technical_activations: 2,
      value_activations: 2,
      active_7d: 115,
      active_28d: 140,
      calls,
      successes: calls - 55,
      errors: 55,
      rate_limited: 0,
    });
  }
  return rows;
}

const REVENUE: RevenueSummary = {
  currency: 'usd',
  mrrMinor: 3_500,
  arrMinor: 42_000,
  payingCustomers: 6,
  compedCustomers: 1,
  arpaMinor: 583,
  atRiskMinor: 0,
  atRiskCustomers: 0,
  leavingMinor: 0,
  leavingCustomers: 0,
  newMrrMinor: 1_500,
  newCustomers: 3,
  churnedMrrMinor: 0,
  churnedCustomers: 0,
  netNewMrrMinor: 1_500,
  byPlan: [{ label: 'Personal', customers: 5, mrrMinor: 2_500 }],
  internalCustomers: 1,
  otherCurrencies: [],
};

/** $100 arrived in August and $150 in September, so $250 crosses in September. */
const CASH: CashCollected = {
  currency: 'usd',
  allTimeMinor: 25_000,
  last30Minor: 15_000,
  months: [
    { month: '2026-08-01', grossMinor: 10_000, refundedMinor: 0, netMinor: 10_000 },
    { month: '2026-09-01', grossMinor: 15_000, refundedMinor: 0, netMinor: 15_000 },
  ],
  charges: 7,
  since: '2026-08-29T10:00:00Z',
  truncated: false,
  mode: 'live',
};

const CHECKOUT: CheckoutFunnel = {
  pricingViewed: 41,
  checkoutStarted: 9,
  checkoutCompleted: 6,
  abandoned: 3,
  checkoutFailed: 0,
  portalOpened: 2,
  planUpgraded: 0,
  planDowngraded: 0,
  internalExcluded: 4,
  lastCompletedAt: '2026-09-01T08:12:00Z',
};

const LIFECYCLE: GrowthLifecycleRow = {
  value_activated: 169,
  one_and_done: 60,
  at_risk: 30,
  active_7d: 115,
  active_28d: 140,
};

const CALM: AchievementInput = {
  signups: signupSeries(),
  daily: dailySeries(),
  revenue: REVENUE,
  cash: CASH,
  checkout: CHECKOUT,
  lifecycle: LIFECYCLE,
};

/*
 * Every test below the fixture passes this instead of the real record, so the
 * ladder rules are tested on their own: a test that asserted "paying-5 has no
 * date" would otherwise be asserting a fact about August 2026 rather than
 * about the code. The record has its own block at the end of the file.
 */
const NO_RECORD: MilestoneUnlockRecord = {};

const ids = (list: Achievement[]) => list.map((entry) => entry.id);
const find = (report: { unlocked: Achievement[]; next: Achievement[] }, id: string) =>
  [...report.unlocked, ...report.next].find((entry) => entry.id === id);

test('the real numbers split into a sensible ladder, and the counts add up', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);

  assert.equal(report.totalCount, ACHIEVEMENT_COUNT);
  assert.equal(report.unlockedCount, report.unlocked.length);
  assert.equal(report.unlockedCount + report.next.length, report.totalCount);

  // Two money rungs cleared at $35 MRR, and $50 still ahead.
  assert.equal(find(report, 'mrr-2500')?.unlocked, true);
  assert.equal(find(report, 'mrr-5000')?.unlocked, false);
  // 339 signups clears 250 and not 500.
  assert.equal(find(report, 'signups-250')?.unlocked, true);
  assert.equal(find(report, 'signups-500')?.unlocked, false);
  // 165,031 calls clears 100,000 and not 250,000.
  assert.equal(find(report, 'tool-calls-100000')?.unlocked, true);
  assert.equal(find(report, 'tool-calls-250000')?.unlocked, false);
  // A 32 day signup streak clears 30 and not 60.
  assert.equal(find(report, 'signup-streak-30')?.unlocked, true);
  assert.equal(find(report, 'signup-streak-60')?.unlocked, false);
  // A best day of 12 clears 10 and not 25.
  assert.equal(find(report, 'record-signup-day-10')?.unlocked, true);
  assert.equal(find(report, 'record-signup-day-25')?.unlocked, false);

  assert.equal(report.unlockedCount, 21);
});

test('a null source removes exactly its own rungs and leaves the rest alone', () => {
  const full = achievementReport(CALM, NOW, NO_RECORD);
  const withoutRevenue = achievementReport({ ...CALM, revenue: null }, NOW, NO_RECORD);

  const dropped = ids([...full.unlocked, ...full.next]).filter(
    (id) => !ids([...withoutRevenue.unlocked, ...withoutRevenue.next]).includes(id),
  );
  assert.ok(dropped.every((id) => id.startsWith('mrr-') || id.startsWith('paying-')));
  assert.equal(withoutRevenue.totalCount, full.totalCount - dropped.length);

  // The checkout funnel feeds no rung, so dropping it changes nothing at all.
  const withoutCheckout = achievementReport({ ...CALM, checkout: null }, NOW, NO_RECORD);
  assert.deepEqual(ids([...withoutCheckout.unlocked, ...withoutCheckout.next]), ids([...full.unlocked, ...full.next]));

  // And a lifecycle outage takes the two lifecycle ladders and nothing else.
  const withoutLifecycle = achievementReport({ ...CALM, lifecycle: null }, NOW, NO_RECORD);
  assert.equal(withoutLifecycle.totalCount, full.totalCount - 9);
  assert.equal(find(withoutLifecycle, 'activated-50'), undefined);
  assert.equal(find(withoutLifecycle, 'signups-100')?.unlocked, true);
});

test('the signup ladder is dated to the day the count first crossed, not the last', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);
  const rows = CALM.signups ?? [];
  const firstAt100 = rows.find((row) => row.cumulative_users >= 100)?.day;
  const lastAt100 = [...rows].reverse().find((row) => row.cumulative_users >= 100)?.day;

  assert.notEqual(firstAt100, lastAt100);
  assert.equal(find(report, 'signups-100')?.unlockedOn, firstAt100);
  assert.equal(find(report, 'signups-250')?.unlockedOn, rows.find((row) => row.cumulative_users >= 250)?.day);
});

test('a target already cleared before the window opened is not dated to the window start', () => {
  // The signup series is windowed while `cumulative_users` is all-time, so the
  // first row standing above a target proves only that it happened earlier.
  const late: GrowthUserSignupDayRow[] = [
    { day: '2026-09-01', new_users: 2, activated_users: 1, cumulative_users: 330 },
    { day: '2026-09-02', new_users: 4, activated_users: 1, cumulative_users: 334 },
    { day: '2026-09-03', new_users: 5, activated_users: 2, cumulative_users: 339 },
  ];
  const report = achievementReport({ ...CALM, signups: late }, NOW, NO_RECORD);
  assert.equal(find(report, 'signups-100')?.unlocked, true);
  assert.equal(find(report, 'signups-100')?.unlockedOn, null);
});

test('the cash ladder is dated to the month that crossed it', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);
  assert.equal(find(report, 'cash-1')?.unlockedOn, '2026-08-01');
  assert.equal(find(report, 'cash-10000')?.unlockedOn, '2026-08-01');
  // $250 only arrives once September's $150 is added to August's $100.
  assert.equal(find(report, 'cash-25000')?.unlockedOn, '2026-09-01');
  assert.equal(find(report, 'cash-50000')?.unlocked, false);
});

test('a rung with neither a series nor a recorded day stays undated', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);
  for (const id of ['mrr-1000', 'mrr-2500', 'paying-1', 'paying-5', 'activated-100', 'active-7d-100', 'signup-streak-30']) {
    const entry = find(report, id);
    assert.equal(entry?.unlocked, true, `${id} should be unlocked in the fixture`);
    assert.equal(entry?.unlockedOn, null, `${id} has no series and must not invent a date`);
  }
});

test('progress is a clamped fraction and never exceeds one', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);
  for (const entry of [...report.unlocked, ...report.next]) {
    assert.ok(entry.progress >= 0 && entry.progress <= 1, `${entry.id} progress out of range`);
    if (entry.unlocked) assert.equal(entry.progress, 1, `${entry.id} is unlocked so progress is 1`);
  }
  // 165,031 of 250,000 calls, well past the point a naive ratio would overflow
  // on the rungs below it.
  const nextCalls = find(report, 'tool-calls-250000');
  assert.ok((nextCalls?.progress ?? 0) > 0.6 && (nextCalls?.progress ?? 0) < 0.7);
});

test('only the two paced ladders project a date, and the money ladders never do', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);

  for (const id of ['mrr-5000', 'mrr-10000', 'cash-50000', 'paying-10', 'activated-250', 'active-7d-250']) {
    assert.equal(find(report, id)?.daysToGo, null, `${id} must not extrapolate`);
  }

  // Three signups a day, 161 to go: a real number of days, not a guess.
  const nextSignups = find(report, 'signups-500');
  assert.equal(nextSignups?.daysToGo, 54);
  assert.equal(typeof find(report, 'tool-calls-250000')?.daysToGo, 'number');
  // An unlocked rung has no distance left to report.
  assert.equal(find(report, 'signups-250')?.daysToGo, null);
});

test('a stalled series refuses to forecast rather than promising a date', () => {
  const flat = (CALM.signups ?? []).map((row) => ({ ...row, new_users: 0 }));
  const report = achievementReport({ ...CALM, signups: flat }, NOW, NO_RECORD);
  assert.equal(find(report, 'signups-500')?.daysToGo, null);
});

test('the next list is ordered closest-first', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);
  for (let i = 1; i < report.next.length; i += 1) {
    assert.ok(
      report.next[i - 1].progress >= report.next[i].progress,
      `${report.next[i - 1].id} should not sit below ${report.next[i].id}`,
    );
  }
  assert.equal(report.next[0].id, 'mrr-5000');
});

test('the unlocked list is ordered most recently unlocked first, undated last', () => {
  const report = achievementReport(CALM, NOW, NO_RECORD);
  const dated = report.unlocked.filter((entry) => entry.unlockedOn !== null);
  const undated = report.unlocked.filter((entry) => entry.unlockedOn === null);

  assert.deepEqual(
    ids(report.unlocked),
    ids([...dated, ...undated]),
    'every dated unlock sorts above every undated one',
  );
  for (let i = 1; i < dated.length; i += 1) {
    assert.ok((dated[i - 1].unlockedOn ?? '') >= (dated[i].unlockedOn ?? ''));
  }
});

test('an empty and a missing world both produce nothing rather than throwing', () => {
  const nothing = achievementReport(
    { signups: null, daily: null, revenue: null, cash: null, checkout: null, lifecycle: null },
    NOW,
  );
  assert.deepEqual(nothing.unlocked, []);
  assert.deepEqual(nothing.next, []);
  assert.equal(nothing.totalCount, 0);

  const zeroed = achievementReport(
    {
      signups: [],
      daily: [],
      revenue: { ...REVENUE, mrrMinor: 0, payingCustomers: 0 },
      cash: { ...CASH, allTimeMinor: 0, months: [], charges: 0, since: null },
      checkout: { ...CHECKOUT, checkoutCompleted: 0, lastCompletedAt: null },
      lifecycle: { value_activated: 0, one_and_done: 0, at_risk: 0, active_7d: 0, active_28d: 0 },
    },
    NOW,
  );
  assert.deepEqual(zeroed.unlocked, []);
  assert.equal(zeroed.totalCount, ACHIEVEMENT_COUNT);
  assert.equal(zeroed.next.length, ACHIEVEMENT_COUNT);
  assert.ok(zeroed.next.every((entry) => entry.progress === 0 && entry.unlockedOn === null));
});

/* ======================================================= recorded unlocks */

test('a recorded day dates an unlocked rung the ladder cannot date itself', () => {
  const report = achievementReport(CALM, NOW);

  // The fixture's MRR is $35 and its customer count 6, so these are unlocked,
  // and Stripe being a snapshot means no ladder could ever date them.
  const mrr = find(report, 'mrr-1000');
  assert.equal(mrr?.unlockedOn, '2026-08-31');
  assert.match(mrr?.unlockedOnNote ?? '', /user_billing/);

  const paying = find(report, 'paying-5');
  assert.equal(paying?.unlockedOn, '2026-09-01');
  assert.ok(paying?.unlockedOnNote);
});

test('a ladder that can date itself is never overridden by the record', () => {
  // `signup-streak-30` is recorded; the signup ladder's own rungs are dated
  // from the series and must keep those days, note-free.
  const report = achievementReport(CALM, NOW);
  const recorded = find(report, 'signup-streak-30');
  const derived = find(report, 'signups-250');

  assert.equal(recorded?.unlockedOn, MILESTONE_UNLOCK_RECORD['signup-streak-30'].day);
  assert.ok(derived?.unlockedOn && derived.unlockedOn > '2026-06-01');
  assert.equal(derived?.unlockedOnNote, null, 'a series-dated rung carries no provenance caveat');
});

test('a recorded day never lands on a rung that is still being climbed', () => {
  // Nothing has been paid and nobody has activated, so every recorded rung is
  // locked. A locked rung with a date would be a milestone reached in advance.
  const empty = achievementReport(
    {
      signups: [],
      daily: [],
      revenue: { ...REVENUE, mrrMinor: 0, payingCustomers: 0 },
      cash: { ...CASH, allTimeMinor: 0, months: [], charges: 0, since: null },
      checkout: CHECKOUT,
      lifecycle: { value_activated: 0, one_and_done: 0, at_risk: 0, active_7d: 0, active_28d: 0 },
    },
    NOW,
  );

  for (const id of Object.keys(MILESTONE_UNLOCK_RECORD)) {
    const entry = find(empty, id);
    assert.equal(entry?.unlocked, false, `${id} should be locked in a zeroed world`);
    assert.equal(entry?.unlockedOn, null, `${id} must not be dated before it is reached`);
    assert.equal(entry?.unlockedOnNote, null);
  }
});

test('every recorded id is a rung that exists, and every day is a real ISO day', () => {
  // A ladder retargeted in ACHIEVEMENT_POLICY leaves its recorded ids pointing
  // at nothing, and the dates would silently stop appearing. This is the test
  // that fails instead.
  const everything = achievementReport(
    {
      signups: signupSeries(),
      daily: dailySeries(),
      revenue: { ...REVENUE, mrrMinor: 10_000_000, payingCustomers: 10_000 },
      cash: { ...CASH, allTimeMinor: 10_000_000 },
      checkout: CHECKOUT,
      lifecycle: { value_activated: 10_000, one_and_done: 0, at_risk: 0, active_7d: 10_000, active_28d: 10_000 },
    },
    NOW,
  );
  const known = new Set([...everything.unlocked, ...everything.next].map((entry) => entry.id));

  for (const [id, unlock] of Object.entries(MILESTONE_UNLOCK_RECORD)) {
    assert.ok(known.has(id), `${id} is recorded but no ladder builds it`);
    assert.match(unlock.day, /^20\d\d-[01]\d-[0-3]\d$/, `${id} has a malformed day`);
    assert.equal(unlock.day, new Date(`${unlock.day}T00:00:00Z`).toISOString().slice(0, 10));
    assert.ok(unlock.note.trim().length > 0, `${id} records a day with no evidence`);
    assert.ok(unlock.day <= '2026-09-17', `${id} is dated in the future`);
  }
});

test('the reached track and the undated pile between them hold every unlock', () => {
  // The panel renders dated unlocks on the month track and undated ones as
  // chips below it. Nothing may fall between the two.
  const report = achievementReport(CALM, NOW);
  const dated = report.unlocked.filter((entry) => entry.unlockedOn !== null).length;
  const undated = report.unlocked.filter((entry) => entry.unlockedOn === null).length;
  assert.equal(dated + undated, report.unlockedCount);
  assert.ok(dated > undated, 'most unlocks should now carry a day');
});
