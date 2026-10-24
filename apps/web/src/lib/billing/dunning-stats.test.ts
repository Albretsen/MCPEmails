// ---------------------------------------------------------------------------
// The failed-payment measurement on /admin/growth/dunning: outcomes by decline
// code, the recovery rate and time to recover, who fixed it, the involuntary
// share of churn, and the banner's reach. The summariseDunning tests live in
// lifecycle-queue.test.ts; these follow the same shape.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/billing/dunning-stats.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_SEQUENCES_FOR_RATE,
  SCA_DECLINE_CODE,
  churnReason,
  median,
  summariseChurn,
  summariseFixClicks,
  summariseOutcomes,
  type DeletionRow,
  type DunningRow,
} from '@/lib/billing/dunning-stats';

const CUSTOMER = 'cus_TEST123';

function row(over: Partial<DunningRow> = {}): DunningRow {
  return {
    template: 'dunning_1',
    category: 'transactional',
    stripe_customer_id: CUSTOMER,
    scope_key: 'in_A',
    send_after: '2026-09-01T00:00:00.000Z',
    sent_at: null,
    cancelled_at: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    recipient: 'customer@example.com',
    payload: { amountCents: 500, currency: 'usd', planId: 'personal', declineCode: 'insufficient_funds' },
    created_at: '2026-09-01T00:00:00.000Z',
    recovered_by: null,
    ...over,
  };
}

/** The four rows of one sequence, all sharing the payload and created_at. */
function sequenceRows(scope: string, over: Partial<DunningRow> = {}, customer = CUSTOMER): DunningRow[] {
  return ['dunning_1', 'dunning_3', 'dunning_7', 'dunning_14'].map((template) =>
    row({ template, scope_key: scope, stripe_customer_id: customer, ...over }),
  );
}

function recovered(scope: string, cancelledAt: string, extra: Partial<DunningRow> = {}): DunningRow[] {
  return sequenceRows(scope, { cancelled_at: cancelledAt, cancel_reason: 'payment_recovered', ...extra });
}

test('a sequence is counted once, not once per row, and sorted into one outcome', () => {
  const s = summariseOutcomes([
    ...recovered('in_A', '2026-09-03T00:00:00.000Z'),
    ...sequenceRows('in_B', { cancelled_at: '2026-09-14T00:00:00.000Z', cancel_reason: 'subscription_deleted' }),
    ...sequenceRows('in_C'),
  ]);
  assert.equal(s.sequences, 3);
  assert.equal(s.recovered, 1);
  assert.equal(s.lost, 1);
  assert.equal(s.open, 1);
  assert.equal(s.closed, 2);
});

test('a sequence whose emails all went out is lost when the subscription was deleted afterwards', () => {
  const rows = sequenceRows('in_A', { sent_at: '2026-09-02T00:00:00.000Z' });
  const deletions: DeletionRow[] = [
    { stripe_customer_id: CUSTOMER, event_created: '2026-09-15T00:00:00.000Z', cancellation_reason: 'payment_failed' },
  ];
  assert.equal(summariseOutcomes(rows).open, 1, 'without the deletion it is still open');
  const s = summariseOutcomes(rows, deletions);
  assert.equal(s.lost, 1);
  assert.equal(s.open, 0);
});

test('a deletion from before the sequence started does not make it lost', () => {
  const s = summariseOutcomes(sequenceRows('in_A', { created_at: '2026-10-01T00:00:00.000Z' }), [
    { stripe_customer_id: CUSTOMER, event_created: '2026-08-01T00:00:00.000Z', cancellation_reason: null },
  ]);
  assert.equal(s.open, 1);
  assert.equal(s.lost, 0);
});

test('another customer\'s deletion does not touch this sequence', () => {
  const s = summariseOutcomes(sequenceRows('in_A'), [
    { stripe_customer_id: 'cus_OTHER', event_created: '2026-09-15T00:00:00.000Z', cancellation_reason: 'payment_failed' },
  ]);
  assert.equal(s.open, 1);
});

test('recovered wins over lost when both are on the rows', () => {
  const s = summariseOutcomes([
    row({ template: 'dunning_1', cancelled_at: '2026-09-02T00:00:00.000Z', cancel_reason: 'payment_recovered' }),
    row({ template: 'dunning_14', cancelled_at: '2026-09-14T00:00:00.000Z', cancel_reason: 'subscription_deleted' }),
  ]);
  assert.equal(s.recovered, 1);
  assert.equal(s.lost, 0);
});

test('by decline code: SCA is its own row and comes first', () => {
  const sca = { payload: { declineCode: SCA_DECLINE_CODE } };
  const s = summariseOutcomes([
    ...recovered('in_A', '2026-09-02T00:00:00.000Z'),
    ...sequenceRows('in_B'),
    ...sequenceRows('in_C', { payload: { declineCode: 'expired_card' } }),
    ...sequenceRows('in_D', sca),
    ...sequenceRows('in_E', { payload: { declineCode: null } }),
  ]);
  assert.equal(s.byDeclineCode[0].code, SCA_DECLINE_CODE);
  assert.equal(s.byDeclineCode[0].sca, true);
  assert.equal(s.byDeclineCode[0].sequences, 1);
  const funds = s.byDeclineCode.find((r) => r.code === 'insufficient_funds');
  assert.deepEqual(funds, { code: 'insufficient_funds', sca: false, sequences: 2, recovered: 1, lost: 0, open: 1 });
  const none = s.byDeclineCode.find((r) => r.code === null);
  assert.equal(none?.sequences, 1, 'no code is a row of its own, not dropped');
  assert.equal(s.byDeclineCode.reduce((n, r) => n + r.sequences, 0), s.sequences);
});

test('win-backs and card warnings are not sequences', () => {
  const s = summariseOutcomes([
    row({ template: 'winback_14', scope_key: 'sub_X:1', cancel_reason: 'payment_recovered', cancelled_at: 'x' }),
    row({ template: 'card_expiry_30', scope_key: 'pm_A:10/2026' }),
  ]);
  assert.equal(s.sequences, 0);
  assert.equal(s.recovered, 0);
});

test('no recovery rate below MIN_SEQUENCES_FOR_RATE closed sequences', () => {
  const rows: DunningRow[] = [];
  for (let i = 0; i < MIN_SEQUENCES_FOR_RATE - 1; i += 1) rows.push(...recovered(`in_${i}`, '2026-09-02T00:00:00.000Z'));
  // Open sequences do not count toward the denominator.
  for (let i = 0; i < 10; i += 1) rows.push(...sequenceRows(`in_open_${i}`));
  const s = summariseOutcomes(rows);
  assert.equal(s.closed, MIN_SEQUENCES_FOR_RATE - 1);
  assert.equal(s.recoveryRate, null);
});

test('the recovery rate is recovered over closed, not over everything', () => {
  const rows: DunningRow[] = [];
  for (let i = 0; i < 3; i += 1) rows.push(...recovered(`in_r${i}`, '2026-09-02T00:00:00.000Z'));
  for (let i = 0; i < 2; i += 1) {
    rows.push(...sequenceRows(`in_l${i}`, { cancelled_at: '2026-09-14T00:00:00.000Z', cancel_reason: 'subscription_deleted' }));
  }
  rows.push(...sequenceRows('in_open'));
  const s = summariseOutcomes(rows);
  assert.equal(s.closed, 5);
  assert.equal(s.recoveryRate, 3 / 5);
});

test('median days to recover runs from the first queued row to the recovery cancel', () => {
  const s = summariseOutcomes([
    ...recovered('in_A', '2026-09-02T00:00:00.000Z'), // 1 day
    ...recovered('in_B', '2026-09-04T00:00:00.000Z'), // 3 days
    ...recovered('in_C', '2026-09-11T00:00:00.000Z'), // 10 days
  ]);
  assert.equal(s.medianDaysToRecover, 3);
  assert.equal(s.recoveredWithTiming, 3);
});

test('a recovered sequence with no created_at is counted but left out of the median', () => {
  const s = summariseOutcomes([
    ...recovered('in_A', '2026-09-02T00:00:00.000Z', { created_at: null }),
  ]);
  assert.equal(s.recovered, 1);
  assert.equal(s.medianDaysToRecover, null);
  assert.equal(s.recoveredWithTiming, 0);
});

test('median of an even count is the mean of the middle two', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('who fixed it is counted per recovered sequence; older rows read as not recorded', () => {
  const s = summariseOutcomes([
    ...recovered('in_A', '2026-09-02T00:00:00.000Z', { recovered_by: 'customer' }),
    ...recovered('in_B', '2026-09-02T00:00:00.000Z', { recovered_by: 'retry' }),
    ...recovered('in_C', '2026-09-02T00:00:00.000Z', { recovered_by: 'retry' }),
    ...recovered('in_D', '2026-09-02T00:00:00.000Z', { recovered_by: 'unknown' }),
    ...recovered('in_E', '2026-09-02T00:00:00.000Z'),
    // Not recovered: never counted, whatever the column says.
    ...sequenceRows('in_F', { recovered_by: 'customer' }),
  ]);
  assert.deepEqual(s.recoveredBy, { customer: 1, retry: 2, unknown: 1, not_recorded: 1 });
});

test('churn reasons fall into four buckets', () => {
  assert.equal(churnReason('payment_failed'), 'payment_failed');
  assert.equal(churnReason('cancellation_requested'), 'cancellation_requested');
  assert.equal(churnReason('payment_disputed'), 'other');
  assert.equal(churnReason('none'), 'other');
  assert.equal(churnReason(null), 'not_recorded');
});

test('churn is grouped by UTC month, newest first, with no share below the minimum', () => {
  const d = (at: string, reason: string | null): DeletionRow => ({
    stripe_customer_id: 'cus_x',
    event_created: at,
    cancellation_reason: reason,
  });
  const months = summariseChurn([
    d('2026-09-30T23:30:00.000Z', null),
    d('2026-10-01T00:30:00.000Z', 'payment_failed'),
    d('2026-10-05T00:00:00.000Z', 'cancellation_requested'),
    d('2026-10-06T00:00:00.000Z', 'payment_disputed'),
  ]);
  assert.deepEqual(
    months.map((m) => m.month),
    ['2026-10', '2026-09'],
  );
  assert.equal(months[0].payment_failed, 1);
  assert.equal(months[0].cancellation_requested, 1);
  assert.equal(months[0].other, 1);
  assert.equal(months[0].total, 3);
  assert.equal(months[0].involuntaryShare, null);
  assert.equal(months[1].not_recorded, 1);
});

test('the involuntary share is over deletions with a recorded reason only', () => {
  const rows: DeletionRow[] = [];
  for (let i = 0; i < 3; i += 1) rows.push({ stripe_customer_id: 'c', event_created: '2026-11-02T00:00:00Z', cancellation_reason: 'payment_failed' });
  for (let i = 0; i < 2; i += 1) rows.push({ stripe_customer_id: 'c', event_created: '2026-11-03T00:00:00Z', cancellation_reason: 'cancellation_requested' });
  for (let i = 0; i < 4; i += 1) rows.push({ stripe_customer_id: 'c', event_created: '2026-11-04T00:00:00Z', cancellation_reason: null });
  const [month] = summariseChurn(rows);
  assert.equal(month.total, 9);
  assert.equal(month.involuntaryShare, 3 / 5);
});

test('banner reach: clicks, where they went, and distinct workspaces', () => {
  const s = summariseFixClicks([
    { workspace_id: 'ws-1', outcome: 'success', occurred_at: '2026-10-25T10:00:00.000Z' },
    { workspace_id: 'ws-1', outcome: 'success', occurred_at: '2026-10-26T10:00:00.000Z' },
    { workspace_id: 'ws-2', outcome: 'failure', occurred_at: '2026-10-25T12:00:00.000Z' },
  ]);
  assert.deepEqual(s, {
    clicks: 3,
    sentToStripe: 2,
    bounced: 1,
    workspaces: 2,
    lastClickAt: '2026-10-26T10:00:00.000Z',
  });
  assert.equal(summariseFixClicks([]).lastClickAt, null);
});
