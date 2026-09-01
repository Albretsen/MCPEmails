import assert from 'node:assert/strict';
import test from 'node:test';

import { PLANS, resolvePlanLimits } from '@/lib/stripe/plans';
import { MIN_RETENTION_DAYS, retentionCutoffISO, retentionDays } from './retention.ts';

test('every tier resolves the retention window it is sold with', () => {
  // These numbers are published copy: the blog posts quote "30-day analytics"
  // on Free and Personal and "90-day" on Pro, so changing one here without
  // changing the copy makes the product lie again, which is the exact state
  // this module was written to fix.
  assert.equal(retentionDays(resolvePlanLimits('free')), 30);
  assert.equal(retentionDays(resolvePlanLimits('personal')), 30);
  assert.equal(retentionDays(resolvePlanLimits('solo')), 90);
  assert.equal(retentionDays(resolvePlanLimits('pro')), 365);
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
  for (const plan of Object.values(PLANS)) {
    assert.ok(
      Number.isFinite(plan.limits.analyticsRetentionDays),
      `plan ${plan.id} must have a finite window; unlimited history is not a tier`,
    );
  }
});

test('a comped workspace gets the Team window, a grandfathered one does not', () => {
  // compedScale grants Team features outright, so it buys Team's history too.
  assert.equal(retentionDays(resolvePlanLimits('free', { compedScale: true })), 365);

  // The 2026-08-19 grandfather lifts the INBOX cap and nothing else. It must
  // not quietly hand a free account a year of history.
  assert.equal(retentionDays(resolvePlanLimits('free', { unlimitedInboxes: true })), 30);
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
