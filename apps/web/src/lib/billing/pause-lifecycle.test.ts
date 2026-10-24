/**
 * The pause emails end to end: the two templates, the queue (timing,
 * re-queue on extend, cancel on resume), the dispatcher's freshness check,
 * the cron re-projection, and the paused level in the money math.
 *
 * Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        src/lib/billing/pause-lifecycle.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { asClient, FakeSupabase } from '@/lib/billing/fake-supabase';
import { PRICES, sec, setPlanChangeTestPrices, subscriptionFixture } from '@/lib/billing/plan-change-fixtures';

setPlanChangeTestPrices();
const { composeBillingEmail, categoryOf } = await import('@/lib/email/billing-lifecycle');
const queue = await import('@/lib/billing/lifecycle-queue');
const { checkFreshness } = await import('@/lib/billing/dispatch-freshness');
const { reprojectDuePlanChanges, isOverdue } = await import('@/lib/billing/plan-change-reproject');
const { summarizeSubscriptions, pausedNow } = await import('@/lib/analytics/revenue-math');

const PAYLOAD = {
  planId: 'solo' as const,
  amountCents: 1500,
  currency: 'usd',
  pauseStartsAt: '2026-11-10T12:00:00.000Z',
  billingResumesAt: '2027-01-10T12:00:00.000Z',
};

// ── Templates ───────────────────────────────────────────────────────────────

for (const template of ['pause_started', 'pause_ending_3'] as const) {
  test(`${template}: transactional, plain, with plan, amount, date and both cancel routes`, () => {
    const email = composeBillingEmail(template, PAYLOAD);
    assert.ok(email);
    assert.equal(categoryOf(template), 'transactional');
    assert.equal(email.unsubscribeUrl, undefined, 'a notice about money is not suppressible');
    for (const text of [email.subject, email.body, email.htmlBody]) {
      assert.equal(text.includes('—'), false, 'no em dash');
      assert.equal(/\bsolo\b|personal_month|solo_month/.test(text), false, 'no plan slug');
      assert.equal(/30 days/.test(text), false);
    }
    assert.match(email.body, /Pro/);
    assert.match(email.body, /\$15\.00/);
    assert.match(email.body, /10 January 2027/);
    assert.match(email.body, /\/dashboard\/settings/);
    assert.match(email.body, /\/cancel\b/);
    assert.match(email.htmlBody, /\/cancel/);
  });
}

test('pause_started states what stays active and the Free allowance from the pause start', () => {
  const email = composeBillingEmail('pause_started', PAYLOAD)!;
  assert.match(email.subject, /10 November 2026/);
  assert.match(email.body, /parked, not deleted/);
  assert.match(email.body, /150 email actions/);
  assert.match(email.body, /counted from the day the pause starts/);
  assert.match(email.body, /Scheduled sends you booked before the pause still go out/);
  assert.match(email.body, /resume early, extend the pause or cancel/);
  assert.equal(/replaces the cancellation/.test(email.body), false);
  assert.match(composeBillingEmail('pause_started', { ...PAYLOAD, replacedCancel: true })!.body, /replaces the cancellation/);
});

test('a grandfathered owner is not told inboxes are parked', () => {
  const email = composeBillingEmail('pause_started', { ...PAYLOAD, grandfathered: true })!;
  assert.equal(/parked/.test(email.body.split('While the plan is paused')[1].split('Billing resumes')[0]), false);
});

test('pause_ending_3 says there is nothing to do to continue', () => {
  const email = composeBillingEmail('pause_ending_3', PAYLOAD)!;
  assert.match(email.subject, /resumes on 10 January 2027/);
  assert.match(email.body, /nothing to do if you want to continue/);
});

// ── Queue ───────────────────────────────────────────────────────────────────

const TARGET = { stripeCustomerId: 'cus_q', userId: 'user-q', recipient: 'q@example.test' };

test('the receipt goes now and the reminder 3 days before billing resumes', async () => {
  const db = new FakeSupabase();
  const now = new Date('2026-10-24T09:00:00Z');
  const billsAt = sec('2027-01-10T12:00:00Z');
  const queued = await queue.queuePauseEmails({
    db: asClient(db), target: TARGET, subscriptionId: 'sub_q', pausedFromSeconds: sec('2026-11-10T12:00:00Z'),
    billsAtSeconds: billsAt, payload: PAYLOAD, now,
  });
  assert.equal(queued, 2);
  const rows = db.table('billing_email_sends');
  const receipt = rows.find((r) => r.template === 'pause_started')!;
  const reminder = rows.find((r) => r.template === 'pause_ending_3')!;
  assert.equal(receipt.send_after, now.toISOString());
  assert.equal(receipt.scope_key, `sub_q:${sec('2026-11-10T12:00:00Z')}`);
  assert.equal(reminder.send_after, '2027-01-07T12:00:00.000Z');
  assert.equal(reminder.scope_key, `sub_q:${billsAt}`);

  // A replay inserts nothing new.
  await queue.queuePauseEmails({
    db: asClient(db), target: TARGET, subscriptionId: 'sub_q', pausedFromSeconds: sec('2026-11-10T12:00:00Z'),
    billsAtSeconds: billsAt, payload: PAYLOAD, now,
  });
  assert.equal(db.table('billing_email_sends').filter((r) => r.template === 'pause_started').length, 1);
});

test('an extension re-queues the reminder and cancels the old one; a resume cancels it', async () => {
  const db = new FakeSupabase();
  const now = new Date('2026-10-24T09:00:00Z');
  await queue.queuePauseReminder({ db: asClient(db), target: TARGET, subscriptionId: 'sub_q', billsAtSeconds: sec('2026-12-10T12:00:00Z'), payload: PAYLOAD, now });
  await queue.queuePauseReminder({ db: asClient(db), target: TARGET, subscriptionId: 'sub_q', billsAtSeconds: sec('2027-02-10T12:00:00Z'), payload: PAYLOAD, now });
  const reminders = db.table('billing_email_sends').filter((r) => r.template === 'pause_ending_3');
  assert.equal(reminders.length, 2);
  assert.equal(reminders.filter((r) => r.cancelled_at).length, 1);
  assert.equal(reminders.find((r) => !r.cancelled_at)!.send_after, '2027-02-07T12:00:00.000Z');

  await queue.cancelPauseReminders(asClient(db), 'cus_q', 'pause_changed');
  assert.equal(db.table('billing_email_sends').filter((r) => !r.cancelled_at).length, 0);
});

test('no reminder when billing resumes in less than 3 days', async () => {
  const db = new FakeSupabase();
  const now = new Date('2026-12-09T00:00:00Z');
  const n = await queue.queuePauseReminder({ db: asClient(db), target: TARGET, subscriptionId: 'sub_q', billsAtSeconds: sec('2026-12-10T12:00:00Z'), payload: PAYLOAD, now });
  assert.equal(n, 0);
});

test('cancellationSource marks only the billing card cancel for that period end', () => {
  assert.equal(queue.cancellationSource({ mcpe_switch_free: '100' }, 100), 'billing_switch_free');
  assert.equal(queue.cancellationSource({ mcpe_switch_free: '100' }, 200), null);
  assert.equal(queue.cancellationSource({}, 100), null);
});

// ── Freshness ───────────────────────────────────────────────────────────────

function stripeWith(subscription: Record<string, unknown>) {
  return {
    invoices: { retrieve: async () => ({}) },
    paymentMethods: { retrieve: async () => ({}) },
    subscriptions: { retrieve: async () => subscription },
  };
}

test('the reminder is sent only while the pause still ends on that renewal', async () => {
  const billsAt = sec('2027-01-10T12:00:00Z');
  const row = { id: 1, template: 'pause_ending_3', scope_key: `sub_q:${billsAt}` };
  const still = stripeWith({ status: 'active', pause_collection: { resumes_at: billsAt - 3600 }, cancel_at: null });
  assert.deepEqual(await checkFreshness(still, row), { send: true });
  const moved = stripeWith({ status: 'active', pause_collection: { resumes_at: billsAt + 86_400 }, cancel_at: null });
  assert.deepEqual(await checkFreshness(moved, row), { send: false, reason: 'no_longer_due' });
  const resumed = stripeWith({ status: 'active', pause_collection: null, cancel_at: null });
  assert.deepEqual(await checkFreshness(resumed, row), { send: false, reason: 'no_longer_due' });
  const stopping = stripeWith({ status: 'active', pause_collection: { resumes_at: billsAt - 3600 }, cancel_at: billsAt - 7200 });
  assert.deepEqual(await checkFreshness(stopping, row), { send: false, reason: 'no_longer_due' });
  const gone = stripeWith({ status: 'canceled' });
  assert.deepEqual(await checkFreshness(gone, { ...row, template: 'pause_started' }), { send: false, reason: 'subscription_deleted' });
});

// ── Cron re-projection ──────────────────────────────────────────────────────

test('isOverdue: a pause that started, a pause that ended long ago, a switch that landed', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const base = { user_id: 'u', stripe_subscription_id: 's', subscription_status: 'active', paused_from: null, pause_resumes_at: null, pending_plan: null, pending_plan_effective_at: null, inbox_keep_order: null };
  assert.equal(isOverdue({ ...base, paused_from: '2026-11-10T00:00:00Z', pause_resumes_at: '2026-12-10T00:00:00Z' }, now), true);
  assert.equal(isOverdue({ ...base, subscription_status: 'paused', paused_from: '2026-11-10T00:00:00Z', pause_resumes_at: '2026-12-10T00:00:00Z' }, now), false);
  assert.equal(isOverdue({ ...base, subscription_status: 'paused', paused_from: '2026-10-10T00:00:00Z', pause_resumes_at: '2026-11-10T00:00:00Z' }, now), true);
  assert.equal(isOverdue({ ...base, pending_plan: 'personal', pending_plan_effective_at: '2026-11-19T00:00:00Z' }, now), true);
  assert.equal(isOverdue({ ...base, pending_plan: 'personal', pending_plan_effective_at: '2026-11-21T00:00:00Z' }, now), false);
});

test('the cron projects a pause the webhook missed', async () => {
  const db = new FakeSupabase();
  const now = new Date();
  const from = Math.floor(now.getTime() / 1000) - 86_400;
  db.seed('user_billing', [{ user_id: 'u1', stripe_subscription_id: 'sub_c', subscription_status: 'active', plan: 'solo',
    paused_from: new Date(from * 1000).toISOString(), pause_resumes_at: new Date((from + 30 * 86_400) * 1000).toISOString(),
    pending_plan: null, pending_plan_effective_at: null, inbox_keep_order: null }]);
  db.seed('workspaces', [{ id: 'w1', owner_id: 'u1', plan: 'solo', deleted_at: null, pro_unlimited_inboxes_exempt: false }]);
  db.onRpc('workspace_inbox_activity', () => ({ data: [], error: null }));
  const subscription = subscriptionFixture({
    id: 'sub_c',
    periodEnd: new Date(from * 1000).toISOString(),
    pauseResumesAt: from + 30 * 86_400,
    metadata: { mcpe_pause_from: String(from), mcpe_pause_months: '1' },
  });
  const result = await reprojectDuePlanChanges(asClient(db), { subscriptions: { retrieve: async () => subscription as never } }, now);
  assert.deepEqual(result, { checked: 1, reprojected: 1, failed: 0 });
  assert.equal(db.table('user_billing')[0].plan, 'free');
  assert.equal(db.table('user_billing')[0].subscription_status, 'paused');
  assert.equal(db.table('workspaces')[0].plan, 'free');
});

// ── Money ───────────────────────────────────────────────────────────────────

test('a running pause is not MRR and not churn; a scheduled one is still MRR', () => {
  const nowSeconds = sec('2026-11-20T00:00:00Z');
  const fact = (id: string, paused: boolean) => ({
    id, status: 'active', createdAt: sec('2026-01-01T00:00:00Z'), endedAt: null, cancelAtPeriodEnd: false, canceledAt: null,
    currency: 'usd', grossMonthlyMinor: 1500, discount: { percentOff: 0, amountOffMonthlyMinor: 0 }, planLabel: 'Pro monthly',
    internal: false, paused,
  });
  const summary = summarizeSubscriptions([fact('a', false), fact('b', true)], { nowSeconds, windowDays: 28 });
  assert.equal(summary.mrrMinor, 1500);
  assert.equal(summary.payingCustomers, 1);
  assert.equal(summary.pausedCustomers, 1);
  assert.equal(summary.pausedMinor, 1500);
  assert.equal(summary.churnedCustomers, 0);
  assert.equal(summary.cancelledCustomers, 0);

  const from = sec('2026-11-10T12:00:00Z');
  const pc = { behavior: 'void', resumes_at: sec('2026-12-10T11:00:00Z') };
  assert.equal(pausedNow({ pause_collection: pc, metadata: { mcpe_pause_from: String(from) } }, nowSeconds), true);
  assert.equal(pausedNow({ pause_collection: pc, metadata: { mcpe_pause_from: String(from) } }, from - 10), false, 'scheduled');
  assert.equal(pausedNow({ pause_collection: pc, metadata: {} }, sec('2026-12-11T00:00:00Z')), false, 'resumed');
  assert.equal(pausedNow({ pause_collection: null }, nowSeconds), false);
  assert.ok(PRICES.proMonth);
});
