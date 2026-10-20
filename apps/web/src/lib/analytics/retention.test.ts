import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PLANS, resolvePlanLimits } from '@/lib/stripe/plans';
import {
  MIN_RETENTION_DAYS,
  retentionCutoffISO,
  retentionDays,
  trimLeadingQuietDays,
} from './retention.ts';

test('the usage series drops quiet days before the first call, down to 30', () => {
  const series = (counts: number[]) => counts.map((count, i) => ({ date: `d${i}`, count }));
  const zeros = (n: number) => new Array(n).fill(0);

  // 730-day window, data only in the last 90 days: 90 bars, not 730.
  const pro = series([...zeros(640), 5, ...zeros(10), ...new Array(79).fill(3)]);
  const shown = trimLeadingQuietDays(pro);
  assert.equal(shown.length, 90);
  assert.equal(shown[0].count, 5);
  // A quiet stretch after the first call is real and kept.
  assert.equal(shown[1].count, 0);

  // Never shorter than 30 days, so Free (and a brand-new workspace) keep the
  // chart they always had.
  assert.equal(trimLeadingQuietDays(series([...zeros(725), 1, 1, 1, 1, 1])).length, 30);
  assert.equal(trimLeadingQuietDays(series(zeros(730))).length, 30);
  assert.equal(trimLeadingQuietDays(series([1, ...zeros(29)])).length, 30);
  assert.equal(trimLeadingQuietDays(series(zeros(7))).length, 7);
  assert.deepEqual(trimLeadingQuietDays([]), []);
});

test('every tier resolves the retention window it is sold with', () => {
  // These numbers are published copy: the pricing table, the privacy policy
  // and the blog posts quote 30 days on Free, 90 on Personal and two years on
  // Pro and Business (owner decision 2026-10-20), so changing one here without
  // changing the copy makes the product lie again, which is the exact state
  // this module was written to fix.
  assert.equal(retentionDays(resolvePlanLimits('free')), 30);
  assert.equal(retentionDays(resolvePlanLimits('personal')), 90);
  assert.equal(retentionDays(resolvePlanLimits('solo')), 730);
  // Business (was Team, sold as 365 but held to 90 by the old flat purge).
  assert.equal(retentionDays(resolvePlanLimits('pro')), 730);
});

test('the activity_log purge keeps every plan at least as long as it shows', () => {
  // The pg_cron job deletes by plan in SQL. If its window for a plan were
  // shorter than the one the dashboard shows, the Usage page would chart days
  // whose rows are already gone. Parse the CASE in the migration and hold it
  // to plans.ts.
  const sql = readFileSync(
    new URL(
      '../../../../../supabase/migrations/20261020153742_activity_log_retention_per_plan.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const fn = sql.slice(sql.indexOf('FUNCTION public.activity_log_retention_window_days'));
  const body = fn.slice(0, fn.indexOf('END;'));
  const sqlDays: Record<string, number> = {};
  for (const m of body.matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)) sqlDays[m[1]] = Number(m[2]);
  const elseDays = Number(/ELSE (\d+)/.exec(body)?.[1]);

  for (const plan of Object.values(PLANS)) {
    assert.equal(
      sqlDays[plan.id],
      plan.limits.analyticsRetentionDays,
      `SQL window for ${plan.id} must equal plans.ts`,
    );
  }
  // A workspace the job cannot classify keeps the longest window, never less.
  const longest = Math.max(...Object.values(PLANS).map((p) => p.limits.analyticsRetentionDays));
  assert.ok(elseDays >= longest, 'unclassified rows must get the longest window');
});

test('no tier resolves below the 30-day floor every account already had', () => {
  // The whole point of the floor: enforcing a window must never TAKE history
  // away from a live account. Free showed 30 days before any of this existed.
  for (const id of ['free', 'personal', 'solo', 'pro', 'nonsense']) {
    assert.ok(
      retentionDays(resolvePlanLimits(id)) >= MIN_RETENTION_DAYS,
      `plan ${id} must not resolve below the ${MIN_RETENTION_DAYS}-day floor`,
    );
  }
});

test('the window ascends with the ladder and never reaches unlimited', () => {
  const ladder = ['free', 'personal', 'solo', 'pro'].map((id) =>
    retentionDays(resolvePlanLimits(id)),
  );
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i] >= ladder[i - 1], 'the ladder must never buy LESS history');
  }
  assert.ok(
    ladder[ladder.length - 1] > ladder[0],
    'the top tier must still buy more history than the bottom',
  );
  // Pro and Business share the same two years.
  assert.equal(ladder[2], ladder[3]);
  for (const plan of Object.values(PLANS)) {
    assert.ok(
      Number.isFinite(plan.limits.analyticsRetentionDays),
      `plan ${plan.id} must have a finite window; unlimited history is not a tier`,
    );
  }
});

test('a comped workspace gets the Business window, a grandfathered one does not', () => {
  // compedScale grants Business features outright, so it buys Business's history too.
  assert.equal(retentionDays(resolvePlanLimits('free', { compedScale: true })), 730);

  // The 2026-08-19 grandfather lifts the INBOX cap and nothing else. It must
  // not quietly hand a free account a year of history.
  assert.equal(retentionDays(resolvePlanLimits('free', { unlimitedInboxes: true })), 30);
  assert.equal(retentionDays(resolvePlanLimits('personal', { unlimitedInboxes: true })), 90);
  // Pro at the inbox-cap cutover keeps unlimited inboxes and Pro's history.
  assert.equal(retentionDays(resolvePlanLimits('solo', { proUnlimitedInboxes: true })), 730);
});

test('an unknown plan falls back to the floor, never to unlimited', () => {
  // A limits object that arrives malformed must land on the floor: enough that
  // nobody loses what they already had, never "show everything".
  assert.equal(retentionDays(resolvePlanLimits('nonsense')), 30);
  assert.equal(retentionDays({ analyticsRetentionDays: 0 }), 30);
  assert.equal(retentionDays({ analyticsRetentionDays: -5 }), 30);
  assert.equal(retentionDays({ analyticsRetentionDays: Infinity }), 30);
  assert.equal(retentionDays({ analyticsRetentionDays: 3 }), 30);
  // @ts-expect-error deliberately malformed input
  assert.equal(retentionDays(undefined), 30);
});

test('the cutoff is anchored to UTC midnight so the window is whole days', () => {
  // Mid-afternoon on the 20th. A 7-day window must start at 00:00 on the 14th:
  // the 14th through the 20th inclusive is exactly seven whole UTC days.
  const now = new Date('2026-09-20T15:42:09.123Z');
  // retentionCutoffISO is the raw date helper: it honours whatever it is
  // handed, and the floor is applied by retentionDays above.
  assert.equal(retentionCutoffISO(7, now), '2026-09-14T00:00:00.000Z');
  assert.equal(retentionCutoffISO(1, now), '2026-09-20T00:00:00.000Z');
  assert.equal(retentionCutoffISO(30, now), '2026-08-22T00:00:00.000Z');
  assert.equal(retentionCutoffISO(90, now), '2026-06-23T00:00:00.000Z');
  assert.equal(retentionCutoffISO(365, now), '2025-09-21T00:00:00.000Z');
});

test('the cutoff crosses month and year boundaries correctly', () => {
  // Date.UTC normalises a negative day-of-month, so this needs no special case,
  // but it is the kind of thing that breaks silently if someone rewrites it
  // with string maths.
  assert.equal(retentionCutoffISO(7, new Date('2026-01-03T09:00:00Z')), '2025-12-28T00:00:00.000Z');
  assert.equal(retentionCutoffISO(30, new Date('2026-03-05T09:00:00Z')), '2026-02-04T00:00:00.000Z');
  // Leap day is inside the window rather than skipped.
  assert.equal(retentionCutoffISO(3, new Date('2028-03-01T12:00:00Z')), '2028-02-28T00:00:00.000Z');
});

test('the cutoff never runs forward when handed nonsense', () => {
  const now = new Date('2026-09-20T15:42:09.123Z');
  for (const bad of [0, -1, NaN, Infinity]) {
    const cutoff = new Date(retentionCutoffISO(bad as number, now));
    assert.ok(cutoff <= now, `a ${bad}-day window must not produce a future cutoff`);
    assert.equal(retentionCutoffISO(bad as number, now), '2026-08-22T00:00:00.000Z');
  }
});
