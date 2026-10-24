/**
 * Pause mechanics: month arithmetic the way Stripe advances a monthly period,
 * the 3-in-12 cap, the state machine, and the exact Stripe parameters.
 *
 * Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        src/lib/billing/pause.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PRICES, sec, setPlanChangeTestPrices, subscriptionFixture } from '@/lib/billing/plan-change-fixtures';

setPlanChangeTestPrices();
const pause = await import('@/lib/billing/pause');

const iso = (s: number) => new Date(s * 1000).toISOString();
const NOW = new Date('2026-10-24T09:00:00Z');

test('addBillingMonths keeps the anchor day, clamped to short months', () => {
  const jan31 = sec('2027-01-31T08:30:00Z');
  assert.equal(iso(pause.addBillingMonths(jan31, 1, jan31)), '2027-02-28T08:30:00.000Z');
  // From the clamped February date, the anchor brings it back to the 31st.
  assert.equal(iso(pause.addBillingMonths(sec('2027-02-28T08:30:00Z'), 1, jan31)), '2027-03-31T08:30:00.000Z');
  assert.equal(iso(pause.addBillingMonths(sec('2027-03-31T08:30:00Z'), 1, jan31)), '2027-04-30T08:30:00.000Z');
  // Leap year.
  const jan30 = sec('2028-01-30T00:00:00Z');
  assert.equal(iso(pause.addBillingMonths(jan30, 1, jan30)), '2028-02-29T00:00:00.000Z');
  // Across a year end, and backwards (the rolling window).
  assert.equal(iso(pause.addBillingMonths(sec('2026-11-10T12:00:00Z'), 3)), '2027-02-10T12:00:00.000Z');
  assert.equal(iso(pause.addBillingMonths(sec('2027-02-10T12:00:00Z'), -12)), '2026-02-10T12:00:00.000Z');
});

test('pauseResumesAt is the renewal N months after the period end, minus one hour', () => {
  const end = sec('2026-11-10T12:00:00Z');
  assert.equal(iso(pause.pauseResumesAt(end, 1)), '2026-12-10T11:00:00.000Z');
  assert.equal(iso(pause.pauseResumesAt(end, 3)), '2027-02-10T11:00:00.000Z');
  assert.equal(pause.resumeBoundary(pause.pauseResumesAt(end, 2)), pause.addBillingMonths(end, 2));
  // An anchor on the 31st, paused from 30 November for one month: 31 December.
  const anchor = sec('2026-08-31T00:00:00Z');
  assert.equal(iso(pause.pauseResumesAt(sec('2026-11-30T00:00:00Z'), 1, anchor)), '2026-12-30T23:00:00.000Z');
});

test('pauseState: none, scheduled before the paid period ends, paused after, none once resumes_at passed', () => {
  const from = sec('2026-11-10T12:00:00Z');
  const resumes = pause.pauseResumesAt(from, 1);
  const sub = subscriptionFixture({ pauseResumesAt: resumes, metadata: { mcpe_pause_from: String(from), mcpe_pause_months: '1' } });
  assert.equal(pause.pauseState(subscriptionFixture(), NOW).state, 'none');
  assert.deepEqual(pause.pauseState(sub, NOW), { state: 'scheduled', pausedFrom: from, resumesAt: resumes, months: 1 });
  assert.equal(pause.pauseState(sub, new Date('2026-11-20T00:00:00Z')).state, 'paused');
  assert.equal(pause.pauseState(sub, new Date((resumes + 1) * 1000)).state, 'none');
  // Paused by hand in Stripe, no metadata: paused from the period start.
  const manual = subscriptionFixture({ pauseResumesAt: resumes });
  assert.equal(pause.pauseState(manual, NOW).state, 'paused');
});

test('pause eligibility: monthly Personal and Pro only, active, nothing else pending', () => {
  assert.deepEqual(pause.pauseEligibility(subscriptionFixture(), NOW), { eligible: true, reason: null, lengths: [1, 2, 3] });
  assert.equal(pause.pauseEligibility(subscriptionFixture({ price: PRICES.personalMonth }), NOW).eligible, true);
  assert.equal(pause.pauseEligibility(subscriptionFixture({ price: PRICES.proYear }), NOW).reason, 'not_monthly');
  assert.equal(pause.pauseEligibility(subscriptionFixture({ price: PRICES.businessMonth }), NOW).reason, 'plan_not_eligible');
  assert.equal(pause.pauseEligibility(subscriptionFixture({ status: 'past_due' }), NOW).reason, 'past_due');
  assert.equal(pause.pauseEligibility(subscriptionFixture({ status: 'trialing' }), NOW).reason, 'not_active');
  assert.equal(pause.pauseEligibility(subscriptionFixture({ extraItem: true }), NOW).reason, 'multiple_items');
  assert.equal(
    pause.pauseEligibility(subscriptionFixture({ metadata: { mcpe_downgrade_effective_at: String(sec('2026-11-10T12:00:00Z')) } }), NOW).reason,
    'downgrade_pending',
  );
  assert.equal(
    pause.pauseEligibility(subscriptionFixture({ pauseResumesAt: sec('2026-12-10T11:00:00Z'), metadata: { mcpe_pause_from: String(sec('2026-11-10T12:00:00Z')) } }), NOW).reason,
    'already_paused',
  );
});

test('at most 3 paused months in any rolling 12', () => {
  const twoUsed = subscriptionFixture({ metadata: { mcpe_pause_history: `${sec('2026-03-10T12:00:00Z')}:2` } });
  assert.deepEqual(pause.pauseEligibility(twoUsed, NOW).lengths, [1]);
  const allUsed = subscriptionFixture({ metadata: { mcpe_pause_history: `${sec('2026-01-10T12:00:00Z')}:1;${sec('2026-05-10T12:00:00Z')}:2` } });
  assert.equal(pause.pauseEligibility(allUsed, NOW).reason, 'cap_reached');
  // A pause from more than 12 months before this one no longer counts.
  const old = subscriptionFixture({ metadata: { mcpe_pause_history: `${sec('2025-10-01T12:00:00Z')}:3` } });
  assert.deepEqual(pause.pauseEligibility(old, NOW).lengths, [1, 2, 3]);
});

test('pauseUpdate: void pause from the period end, cancel cleared, history written', () => {
  const end = sec('2026-11-10T12:00:00Z');
  const plain = pause.pauseUpdate(subscriptionFixture(), 2, NOW);
  assert.deepEqual(plain.params.pause_collection, { behavior: 'void', resumes_at: pause.pauseResumesAt(end, 2) });
  assert.equal('cancel_at' in plain.params, false, 'no cancel field when none was scheduled');
  assert.equal(plain.params.metadata.mcpe_pause_from, String(end));
  assert.equal(plain.params.metadata.mcpe_pause_months, '2');
  assert.equal(plain.params.metadata.mcpe_pause_history, `${end}:2`);

  const cancelling = pause.pauseUpdate(subscriptionFixture({ cancelAt: end }), 1, NOW);
  assert.equal(cancelling.params.cancel_at, '', 'the scheduled cancel is cleared in the same call (T12)');

  assert.throws(() => pause.pauseUpdate(subscriptionFixture(), 4, NOW), /invalid_months/);
  assert.throws(() => pause.pauseUpdate(subscriptionFixture({ price: PRICES.proYear }), 1, NOW), /not_monthly/);
});

test('extend: within the cap, from the same start, history entry updated', () => {
  const from = sec('2026-11-10T12:00:00Z');
  const sub = subscriptionFixture({
    pauseResumesAt: pause.pauseResumesAt(from, 1),
    metadata: { mcpe_pause_from: String(from), mcpe_pause_months: '1', mcpe_pause_history: `${from}:1` },
  });
  assert.deepEqual(pause.extendEligibility(sub, NOW).lengths, [1, 2]);
  const ext = pause.extendUpdate(sub, 2, NOW);
  assert.equal(ext.months, 3);
  assert.deepEqual(ext.params.pause_collection, { behavior: 'void', resumes_at: pause.pauseResumesAt(from, 3) });
  assert.equal(ext.params.metadata.mcpe_pause_history, `${from}:3`);
  assert.throws(() => pause.extendUpdate(sub, 3, NOW), /invalid_months/);
  assert.equal(pause.extendEligibility(subscriptionFixture(), NOW).reason, 'not_paused');
});

test('resume early: a scheduled pause is removed; a running one returns at the next renewal minus an hour', () => {
  const from = sec('2026-11-10T12:00:00Z');
  const scheduled = subscriptionFixture({
    pauseResumesAt: pause.pauseResumesAt(from, 3),
    metadata: { mcpe_pause_from: String(from), mcpe_pause_months: '3', mcpe_pause_history: `${from}:3` },
  });
  const removed = pause.resumeEarlyUpdate(scheduled, NOW);
  assert.equal(removed.kind, 'removed');
  assert.equal(removed.params.pause_collection, '');
  assert.equal(removed.params.metadata.mcpe_pause_history, '', 'an unused pause does not count against the cap');

  // Running: the period has rolled to 10 Dec - 10 Jan inside the pause.
  const running = subscriptionFixture({
    periodStart: '2026-12-10T12:00:00Z',
    periodEnd: '2027-01-10T12:00:00Z',
    anchor: '2026-10-10T12:00:00Z',
    pauseResumesAt: pause.pauseResumesAt(from, 3),
    metadata: { mcpe_pause_from: String(from), mcpe_pause_months: '3', mcpe_pause_history: `${from}:3` },
  });
  const now = new Date('2026-12-20T00:00:00Z');
  assert.equal(pause.pauseState(running, now).state, 'paused');
  const early = pause.resumeEarlyUpdate(running, now);
  assert.equal(early.kind, 'next_renewal');
  assert.deepEqual(early.params.pause_collection, { behavior: 'void', resumes_at: sec('2027-01-10T11:00:00Z') });
  assert.equal(early.billsAt, sec('2027-01-10T12:00:00Z'));
  assert.equal(early.params.metadata.mcpe_pause_months, '2', 'two months were actually paused');
  assert.equal(early.params.metadata.mcpe_pause_early, '1');
  assert.throws(() => pause.resumeEarlyUpdate(subscriptionFixture(), NOW), /not_paused/);
});

test('history round-trips and drops junk', () => {
  assert.deepEqual(pause.parsePauseHistory('100:1;bad;200:x;300:2'), [
    { from: 100, months: 1 },
    { from: 300, months: 2 },
  ]);
  assert.equal(pause.formatPauseHistory([{ from: 300, months: 2 }, { from: 100, months: 1 }]), '100:1;300:2');
});
