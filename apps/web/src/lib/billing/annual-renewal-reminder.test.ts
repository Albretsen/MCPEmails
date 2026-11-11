// Annual renewal reminder: the flag, the candidate rule, the Stripe decision,
// the email copy, the freshness check before the send, and a run end to end
// against the fake database in dry_run and on.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/billing/annual-renewal-reminder.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_m';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_y';
process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.com';

const {
  annualRenewalReminderMode,
  isRenewalCandidate,
  decideRenewal,
  runAnnualRenewalReminder,
} = await import('./annual-renewal-reminder.ts');
const { composeBillingEmail } = await import('@/lib/email/billing-lifecycle');
const { checkFreshness } = await import('@/lib/billing/dispatch-freshness');
const { FakeSupabase, asClient } = await import('@/lib/billing/fake-supabase');
const { setDispatchKickForTests } = await import('@/lib/billing/dispatch-kick');

type Sub = Parameters<typeof decideRenewal>[0];

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2027-07-30T07:20:00Z');
const END = Math.floor((NOW.getTime() + 30 * DAY - 60_000) / 1000);

function sub(overrides: Partial<Sub> = {}): Sub {
  return {
    id: 'sub_y',
    status: 'active',
    customer: { id: 'cus_y', email: 'Owner@Example.com' },
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    items: {
      data: [{ current_period_end: END, price: { id: 'price_personal_y', recurring: { interval: 'year' } } }],
    },
    ...overrides,
  };
}

test('the flag is off unless it says dry_run or on', () => {
  assert.equal(annualRenewalReminderMode({}), 'off');
  assert.equal(annualRenewalReminderMode({ ANNUAL_RENEWAL_REMINDER_ENABLED: 'yes' }), 'off');
  assert.equal(annualRenewalReminderMode({ ANNUAL_RENEWAL_REMINDER_ENABLED: 'dry_run' }), 'dry_run');
  assert.equal(annualRenewalReminderMode({ ANNUAL_RENEWAL_REMINDER_ENABLED: 'on' }), 'on');
});

test('a candidate is an annual-length stored period ending 27 to 30 days out', () => {
  const row = (endDays: number, lengthDays: number) => ({
    user_id: 'u',
    stripe_customer_id: 'cus',
    stripe_subscription_id: 'sub',
    current_period_end: new Date(NOW.getTime() + endDays * DAY).toISOString(),
    current_period_start: new Date(NOW.getTime() + (endDays - lengthDays) * DAY).toISOString(),
  });
  assert.equal(isRenewalCandidate(row(29.5, 365), NOW), true);
  assert.equal(isRenewalCandidate(row(27.5, 365), NOW), true);
  assert.equal(isRenewalCandidate(row(31, 365), NOW), false);
  assert.equal(isRenewalCandidate(row(20, 365), NOW), false);
  // A monthly period renewing in 29 days is never a candidate.
  assert.equal(isRenewalCandidate(row(29, 30), NOW), false);
  // The dry-run horizon looks further ahead.
  assert.equal(isRenewalCandidate(row(200, 365), NOW, 365), true);
});

test('only a live, uncancelled, unpaused, all-yearly subscription is reminded', () => {
  const ok = decideRenewal(sub());
  assert.equal(ok.send, true);
  if (ok.send) {
    assert.equal(ok.periodEnd, END);
    assert.equal(ok.planId, 'personal');
    assert.equal(ok.email, 'Owner@Example.com');
  }
  assert.deepEqual(decideRenewal(sub({ status: 'past_due' })), { send: false, reason: 'not_live' });
  assert.deepEqual(decideRenewal(sub({ cancel_at: END })), { send: false, reason: 'cancelling' });
  assert.deepEqual(decideRenewal(sub({ cancel_at_period_end: true })), { send: false, reason: 'cancelling' });
  assert.deepEqual(decideRenewal(sub({ pause_collection: { behavior: 'void' } })), { send: false, reason: 'paused' });
  assert.deepEqual(
    decideRenewal(sub({ items: { data: [{ current_period_end: END, price: { id: 'price_personal_m', recurring: { interval: 'month' } } }] } })),
    { send: false, reason: 'not_annual' },
  );
});

test('the email states date, amount, currency and plan, and how to cancel or go monthly', () => {
  const email = composeBillingEmail('annual_renewal_30', {
    planId: 'personal',
    amountCents: 8640,
    currency: 'eur',
    periodEnd: '2027-08-29T09:00:00.000Z',
    interval: 'year',
  });
  assert.ok(email);
  assert.equal(email.category, 'transactional');
  assert.equal(email.subject, 'Your MCPEmails Personal plan renews on 29 August 2027');
  assert.match(email.body, /€86\.40/);
  assert.match(email.body, /Your Personal plan is billed once a year and renews on 29 August 2027/);
  assert.match(email.body, /https:\/\/mcpemails\.com\/dashboard\/settings\?switch_interval=month/);
  assert.match(email.body, /https:\/\/mcpemails\.com\/cancel/);
  for (const text of [email.body, email.htmlBody]) {
    // The 14-day refund covers a first charge only (terms 5.4), so no refund line.
    assert.doesNotMatch(text, /refund/i);
    assert.doesNotMatch(text, /—/);
    assert.doesNotMatch(text, /solo|pro_month/);
  }
  assert.equal(email.unsubscribeUrl, undefined);
  // No amount or no date: nothing true to say, nothing composed.
  assert.equal(composeBillingEmail('annual_renewal_30', { planId: 'personal', periodEnd: '2027-08-29T09:00:00Z' }), null);
  assert.equal(composeBillingEmail('annual_renewal_30', { planId: 'personal', amountCents: 8640, currency: 'usd' }), null);
});

test('freshness: the row is dropped when the renewal is no longer as queued', async () => {
  const row = { id: 1, template: 'annual_renewal_30', scope_key: `sub_y:${END}` };
  const stripeWith = (s: Sub) => ({
    invoices: { retrieve: async () => ({}) },
    paymentMethods: { retrieve: async () => ({}) },
    subscriptions: { retrieve: async () => s as never },
  });
  assert.deepEqual(await checkFreshness(stripeWith(sub()), row), { send: true });
  assert.equal((await checkFreshness(stripeWith(sub({ cancel_at: END })), row)).send, false);
  assert.equal((await checkFreshness(stripeWith(sub({ status: 'canceled' })), row)).send, false);
  const renewedEarlier = sub({ items: { data: [{ current_period_end: END + 86400, price: { id: 'price_personal_y', recurring: { interval: 'year' } } }] } });
  assert.equal((await checkFreshness(stripeWith(renewedEarlier), row)).send, false);
  const monthly = sub({ items: { data: [{ current_period_end: END, price: { id: 'price_personal_m', recurring: { interval: 'month' } } }] } });
  assert.equal((await checkFreshness(stripeWith(monthly), row)).send, false);
});

function seededDb() {
  const db = new FakeSupabase();
  db.unique('billing_email_sends', ['stripe_customer_id', 'template', 'scope_key']);
  db.seed('user_billing', [
    {
      user_id: 'user-annual',
      stripe_customer_id: 'cus_y',
      stripe_subscription_id: 'sub_y',
      subscription_status: 'active',
      current_period_start: new Date((END - 365 * 86400) * 1000).toISOString(),
      current_period_end: new Date(END * 1000).toISOString(),
    },
    {
      user_id: 'user-monthly',
      stripe_customer_id: 'cus_m',
      stripe_subscription_id: 'sub_m',
      subscription_status: 'active',
      current_period_start: new Date(NOW.getTime() - DAY).toISOString(),
      current_period_end: new Date(NOW.getTime() + 29 * DAY).toISOString(),
    },
  ]);
  return db;
}

test('a run queues one row per subscription and period; dry_run writes nothing', async () => {
  const kicked: number[][] = [];
  setDispatchKickForTests({ scheduler: (task) => { void task(); }, runner: async (ids) => { kicked.push(ids); } });
  const reads: string[] = [];
  const stripe = {
    retrieveSubscription: async (id: string) => { reads.push(id); return sub({ id }); },
    previewRenewal: async () => ({ amount_due: 8640, currency: 'usd' }),
  };

  const db = seededDb();
  const dry = await runAnnualRenewalReminder({ db: asClient(db), stripe, mode: 'dry_run', now: NOW });
  assert.equal(dry.candidates, 1, 'the monthly row is filtered before Stripe');
  assert.deepEqual(reads, ['sub_y']);
  assert.equal(dry.wouldQueue.length, 1);
  assert.equal(dry.wouldQueue[0].to, 'o****r@example.com');
  assert.match(dry.wouldQueue[0].subject ?? '', /renews on/);
  assert.equal(db.table('billing_email_sends').length, 0);

  const first = await runAnnualRenewalReminder({ db: asClient(db), stripe, mode: 'on', now: NOW });
  assert.equal(first.queued, 1);
  const rows = db.table('billing_email_sends');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].template, 'annual_renewal_30');
  assert.equal(rows[0].scope_key, `sub_y:${END}`);
  assert.equal(rows[0].recipient, 'owner@example.com');
  assert.deepEqual(
    { amount: (rows[0].payload as { amountCents: number }).amountCents, currency: (rows[0].payload as { currency: string }).currency },
    { amount: 8640, currency: 'usd' },
  );

  const second = await runAnnualRenewalReminder({ db: asClient(db), stripe, mode: 'on', now: new Date(NOW.getTime() + DAY) });
  assert.equal(second.queued, 0);
  assert.equal(second.alreadyQueued, 1);
  assert.equal(db.table('billing_email_sends').length, 1);

  const off = await runAnnualRenewalReminder({ db: asClient(db), stripe, mode: 'off', now: NOW });
  assert.equal(off.candidates, 0);
  setDispatchKickForTests({ scheduler: null, runner: null });
});

test('nothing to charge, or a monthly subscription at Stripe, queues nothing', async () => {
  const db = seededDb();
  const zero = await runAnnualRenewalReminder({
    db: asClient(db),
    stripe: { retrieveSubscription: async () => sub(), previewRenewal: async () => ({ amount_due: 0, currency: 'usd' }) },
    mode: 'on',
    now: NOW,
  });
  assert.deepEqual(zero.skipped, { nothing_to_charge: 1 });
  const monthly = await runAnnualRenewalReminder({
    db: asClient(db),
    stripe: {
      retrieveSubscription: async () => sub({ items: { data: [{ current_period_end: END, price: { id: 'price_personal_m', recurring: { interval: 'month' } } }] } }),
      previewRenewal: async () => { throw new Error('must not preview'); },
    },
    mode: 'on',
    now: NOW,
  });
  assert.deepEqual(monthly.skipped, { not_annual: 1 });
  assert.equal(db.table('billing_email_sends').length, 0);
});
