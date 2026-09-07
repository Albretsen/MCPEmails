/**
 * Tests for the billing lifecycle QUEUE and the dispatcher's decisions.
 *
 * src/lib/email/billing-lifecycle.ts had 23 tests and this side had none, which
 * was the wrong way round. The composer decides what an email says; these two
 * modules decide whether a customer gets one at all, whether they get it twice,
 * and whether it arrives after we already took their money. Those are the
 * failures that cost a subscription rather than a sentence.
 *
 * NOTHING HERE TOUCHES A NETWORK. The Supabase client is the in-memory fake in
 * ./fake-supabase.ts, which enforces the real unique index rather than
 * pretending to; the Stripe client is three functions supplied per test.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/billing/lifecycle-queue.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import {
  cancelDunningForCustomer,
  cancelOpenSequence,
  hasCancellationSeries,
  isGrandfathered,
  queueCancellationSequence,
  queueCardExpiryWarning,
  queueDunningSequence,
  resolveRecipient,
  resolveUserId,
} from '@/lib/billing/lifecycle-queue';
import {
  lifecycleMode,
  lifecycleQueueingEnabled,
  lifecycleSendingEnabled,
} from '@/lib/billing/lifecycle-mode';
import {
  BATCH_SIZE,
  RETRY_REASON,
  WALL_CLOCK_BUDGET_MS,
  budgetExhausted,
  checkFreshness,
  type FreshnessStripe,
} from '@/lib/billing/dispatch-freshness';
import { DUNNING_SCHEDULE, composeBillingEmail } from '@/lib/email/billing-lifecycle';
import {
  maskAddress,
  summariseDunning,
  type DunningRow,
} from '@/lib/billing/dunning-stats';

const CUSTOMER = 'cus_TEST123';
const INVOICE = 'in_TEST123';
const SUBSCRIPTION = 'sub_TEST123';
const USER = '00000000-0000-4000-8000-000000000001';

function target() {
  return { stripeCustomerId: CUSTOMER, userId: USER, recipient: 'customer@example.com' };
}

function payload() {
  return { planId: 'personal' as const, amountCents: 500, currency: 'usd' };
}

function queued(db: FakeSupabase) {
  return db.table('billing_email_sends');
}

// ---------------------------------------------------------------------------
// Idempotency. The single most expensive bug this feature can ship.
// ---------------------------------------------------------------------------

test('a failed invoice queues the whole four-email sequence, each with its own send_after', async () => {
  const db = new FakeSupabase();
  const now = new Date('2026-09-07T12:00:00.000Z');

  const n = await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
    now,
  });

  assert.equal(n, 4);
  const rows = queued(db);
  assert.deepEqual(
    rows.map((r) => r.template),
    ['dunning_1', 'dunning_3', 'dunning_7', 'dunning_14'],
  );

  // The first is due immediately, which the five-minute cadence turns into
  // "within an hour of the decline". The rest carry their own offsets, so the
  // dispatcher never has to work out whether day 3 has arrived.
  for (const [i, { dayOffset }] of DUNNING_SCHEDULE.entries()) {
    const expected = new Date(now.getTime() + dayOffset * 86_400_000).toISOString();
    assert.equal(rows[i].send_after, expected, `${rows[i].template} is due on day ${dayOffset}`);
  }
  assert.equal(rows[0].send_after, now.toISOString());
});

test('Stripe REDELIVERING the same invoice.payment_failed queues nothing the second time', async () => {
  const db = new FakeSupabase();
  const args = {
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
    now: new Date('2026-09-07T12:00:00.000Z'),
  };

  assert.equal(await queueDunningSequence(args), 4);
  // Identical call, as a redelivery of the identical event would produce.
  assert.equal(await queueDunningSequence(args), 0);
  assert.equal(queued(db).length, 4, 'the queue still holds exactly one sequence');
});

test('TWO DIFFERENT EVENT IDS for the same failed invoice queue nothing the second time', async () => {
  // This is the case the webhook's stripe_webhook_events ledger CANNOT catch.
  // That ledger dedupes on event id, and Stripe emits a fresh event id for every
  // retry attempt on the same invoice: attempt 2 on day 3 is a genuinely new
  // event describing a failure the customer has already been written to about.
  // The only thing standing between that and a second copy of every dunning
  // email is UNIQUE (stripe_customer_id, template, scope_key), keyed on the
  // INVOICE, which is what this asserts.
  const db = new FakeSupabase();

  const firstAttempt = await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: { ...payload(), declineCode: 'insufficient_funds' },
    now: new Date('2026-09-07T12:00:00.000Z'),
  });

  // Three days later, a different event id, a different decline code, a
  // different clock. Same invoice.
  const secondAttempt = await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: { ...payload(), declineCode: 'do_not_honor' },
    now: new Date('2026-09-10T12:00:00.000Z'),
  });

  assert.equal(firstAttempt, 4);
  assert.equal(secondAttempt, 0);
  assert.equal(queued(db).length, 4);
  // And the schedule is the ORIGINAL one. A second attempt must not push the
  // day-14 email out to day 17.
  assert.equal(queued(db)[3].send_after, new Date('2026-09-21T12:00:00.000Z').toISOString());
});

test('a SECOND, GENUINELY DIFFERENT failed invoice gets its own sequence', async () => {
  // The mirror image of the test above, and the reason scope_key is the invoice
  // id rather than the subscription id. A card that fails in September and again
  // in October is two failures, and the October one deserves to be told.
  const db = new FakeSupabase();
  const common = { db: asClient(db), target: target(), payload: payload() };

  await queueDunningSequence({ ...common, invoiceId: 'in_SEPTEMBER' });
  const october = await queueDunningSequence({ ...common, invoiceId: 'in_OCTOBER' });

  assert.equal(october, 4);
  assert.equal(queued(db).length, 8);
});

test('the cancellation series is queued once, and the win-backs hang off the PERIOD END', async () => {
  const db = new FakeSupabase();
  const now = new Date('2026-09-07T12:00:00.000Z');
  // They cancel in September; the annual period runs to March.
  const periodEnd = Math.floor(Date.parse('2027-03-01T00:00:00.000Z') / 1000);

  const args = {
    db: asClient(db),
    target: target(),
    subscriptionId: SUBSCRIPTION,
    periodEndSeconds: periodEnd,
    payload: payload(),
    now,
  };

  assert.equal(await queueCancellationSequence(args), 3);
  assert.equal(await queueCancellationSequence(args), 0, 'repeated updated events queue nothing');

  const rows = queued(db);
  // The question goes now, while the reason is fresh.
  assert.equal(rows[0].template, 'cancel_ask');
  assert.equal(rows[0].send_after, now.toISOString());
  // The win-backs go 14 and 30 days after the product actually stopped, not
  // after the click. For this subscriber those are six months apart.
  assert.equal(
    rows[1].send_after,
    new Date(periodEnd * 1000 + 14 * 86_400_000).toISOString(),
  );
  assert.equal(
    rows[2].send_after,
    new Date(periodEnd * 1000 + 30 * 86_400_000).toISOString(),
  );
});

test('with no period end the question still goes and the win-backs are skipped, not guessed', async () => {
  const db = new FakeSupabase();
  const n = await queueCancellationSequence({
    db: asClient(db),
    target: target(),
    subscriptionId: SUBSCRIPTION,
    periodEndSeconds: null,
    payload: payload(),
  });

  assert.equal(n, 1);
  assert.deepEqual(queued(db).map((r) => r.template), ['cancel_ask']);
});

test('the daily card sweep warns once per card, and again when the card is replaced', async () => {
  const db = new FakeSupabase();
  const base = {
    db: asClient(db),
    target: target(),
    template: 'card_expiry_30' as const,
    payload: payload(),
  };

  assert.equal(await queueCardExpiryWarning({ ...base, paymentMethodId: 'pm_A', expiryKey: '10/2026' }), 1);
  // Tomorrow's sweep sees the same card.
  assert.equal(await queueCardExpiryWarning({ ...base, paymentMethodId: 'pm_A', expiryKey: '10/2026' }), 0);
  // They swap it for another card that also expires soon.
  assert.equal(await queueCardExpiryWarning({ ...base, paymentMethodId: 'pm_B', expiryKey: '11/2026' }), 1);
  assert.equal(queued(db).length, 2);
});

// ---------------------------------------------------------------------------
// Cancelling an in-flight sequence. "Never dun somebody who has paid."
// ---------------------------------------------------------------------------

test('a PAID invoice cancels the rest of that sequence, with a reason that says why', async () => {
  const db = new FakeSupabase();
  await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
  });

  // The retry works on day 2. This is what handleInvoicePaymentSucceeded does.
  const cancelled = await cancelOpenSequence({
    db: asClient(db),
    stripeCustomerId: CUSTOMER,
    scopeKey: INVOICE,
    reason: 'payment_recovered',
  });

  assert.equal(cancelled, 4);
  for (const row of queued(db)) {
    assert.equal(row.cancel_reason, 'payment_recovered');
    assert.ok(row.cancelled_at, `${row.template} carries a cancellation timestamp`);
  }
});

test('cancelling one invoice never touches another invoice, or another customer', async () => {
  const db = new FakeSupabase();
  await queueDunningSequence({ db: asClient(db), target: target(), invoiceId: 'in_ONE', payload: payload() });
  await queueDunningSequence({ db: asClient(db), target: target(), invoiceId: 'in_TWO', payload: payload() });
  await queueDunningSequence({
    db: asClient(db),
    target: { ...target(), stripeCustomerId: 'cus_SOMEBODY_ELSE' },
    invoiceId: 'in_THREE',
    payload: payload(),
  });

  await cancelOpenSequence({
    db: asClient(db),
    stripeCustomerId: CUSTOMER,
    scopeKey: 'in_ONE',
    reason: 'payment_recovered',
  });

  const open = queued(db).filter((r) => !r.cancelled_at);
  assert.equal(open.length, 8);
  assert.ok(open.every((r) => r.scope_key !== 'in_ONE'));
});

test('an email that has already SENT cannot be un-sent by cancelling', async () => {
  const db = new FakeSupabase();
  await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
  });
  // dunning_1 went out an hour after the decline.
  queued(db)[0].sent_at = '2026-09-07T13:00:00.000Z';

  const cancelled = await cancelOpenSequence({
    db: asClient(db),
    stripeCustomerId: CUSTOMER,
    scopeKey: INVOICE,
    reason: 'payment_recovered',
  });

  assert.equal(cancelled, 3, 'only the three still pending');
  assert.equal(queued(db)[0].cancelled_at, null);
  assert.equal(queued(db)[0].sent_at, '2026-09-07T13:00:00.000Z');
});

test('a deleted subscription cancels the first three dunning emails and BRINGS THE LAST ONE FORWARD', async () => {
  const db = new FakeSupabase();
  await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
    now: new Date('2026-09-07T12:00:00.000Z'),
  });
  await queueCancellationSequence({
    db: asClient(db),
    target: target(),
    subscriptionId: SUBSCRIPTION,
    periodEndSeconds: Math.floor(Date.parse('2026-09-29T00:00:00.000Z') / 1000),
    payload: payload(),
  });

  const n = await cancelDunningForCustomer(asClient(db), CUSTOMER, 'subscription_deleted');

  // "Update your card and this carries on" is a lie once there is nothing to
  // carry on, so those three go.
  assert.equal(n, 3);
  const byTemplate = new Map(queued(db).map((r) => [r.template as string, r]));
  for (const t of ['dunning_1', 'dunning_3', 'dunning_7']) {
    assert.ok(byTemplate.get(t)!.cancelled_at, `${t} is cancelled`);
    assert.equal(byTemplate.get(t)!.cancel_reason, 'subscription_deleted');
  }

  // dunning_14 says "the retries are finished, so the subscription is closing".
  // That is not true on day 14 by calendar; it is true at exactly this moment.
  // Cancelling it would delete the one email written for this event.
  const last = byTemplate.get('dunning_14')!;
  assert.equal(last.cancelled_at, null, 'the last note survives the deletion');
  assert.ok(
    Date.parse(last.send_after as string) <= Date.now(),
    'and is due now rather than on its original day-14 date',
  );
  assert.notEqual(last.send_after, new Date('2026-09-21T12:00:00.000Z').toISOString());

  // The win-backs are untouched: this event is exactly when they start to make
  // sense.
  const open = queued(db).filter((r) => !r.cancelled_at);
  assert.deepEqual(
    open.map((r) => r.template).sort(),
    ['cancel_ask', 'dunning_14', 'winback_14', 'winback_30'],
  );
});

test('a write failure while cancelling is swallowed, never thrown at the webhook', async () => {
  // The webhook calls this AFTER it has written the customer's plan. A throw
  // would roll the ledger row back and re-run that plan change, so a lifecycle
  // email must never be able to cost somebody their entitlement.
  const db = new FakeSupabase();
  db.failOnce('billing_email_sends', { message: 'connection reset' });

  const n = await cancelOpenSequence({
    db: asClient(db),
    stripeCustomerId: CUSTOMER,
    reason: 'payment_recovered',
  });
  assert.equal(n, 0);
});

test('a write failure while queueing is swallowed too', async () => {
  const db = new FakeSupabase();
  db.failOnce('billing_email_sends', { message: 'connection reset' });

  const n = await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
  });
  assert.equal(n, 0);
});

// ---------------------------------------------------------------------------
// The cancellation series on an IMMEDIATE deletion.
// ---------------------------------------------------------------------------

test('hasCancellationSeries sees an existing series and does not see an unrelated one', async () => {
  const db = new FakeSupabase();
  await queueCancellationSequence({
    db: asClient(db),
    target: target(),
    subscriptionId: SUBSCRIPTION,
    periodEndSeconds: Math.floor(Date.parse('2026-09-29T00:00:00.000Z') / 1000),
    payload: payload(),
  });

  // Matches on the subscription id even though the stored scope_key carries a
  // period-end suffix the delete event may not reproduce to the second.
  assert.equal(await hasCancellationSeries(asClient(db), CUSTOMER, SUBSCRIPTION), true);
  assert.equal(await hasCancellationSeries(asClient(db), CUSTOMER, 'sub_OTHER'), false);
});

test('a dunning row alone does not look like a cancellation series', async () => {
  const db = new FakeSupabase();
  await queueDunningSequence({
    db: asClient(db),
    target: target(),
    invoiceId: INVOICE,
    payload: payload(),
  });
  assert.equal(await hasCancellationSeries(asClient(db), CUSTOMER, SUBSCRIPTION), false);
});

test('hasCancellationSeries fails towards NOT queueing when it cannot read', async () => {
  const db = new FakeSupabase();
  db.failOnce('billing_email_sends', { message: 'timeout' });
  assert.equal(
    await hasCancellationSeries(asClient(db), CUSTOMER, SUBSCRIPTION),
    true,
    'a missed win-back beats a duplicate "what stopped working for you?"',
  );
});

// ---------------------------------------------------------------------------
// Resolution helpers.
// ---------------------------------------------------------------------------

test('the recipient is the Stripe billing address, falling back to the login email', async () => {
  const db = new FakeSupabase();
  db.seed('users', [{ id: USER, email: 'Login@Example.com' }]);

  assert.equal(await resolveRecipient(asClient(db), ' Billing@Example.com ', USER), 'billing@example.com');
  assert.equal(await resolveRecipient(asClient(db), null, USER), 'login@example.com');
  assert.equal(await resolveRecipient(asClient(db), null, null), null);
});

test('the owner is resolved from metadata first, then user_billing', async () => {
  const db = new FakeSupabase();
  db.seed('user_billing', [{ stripe_customer_id: CUSTOMER, user_id: USER }]);

  assert.equal(await resolveUserId(asClient(db), CUSTOMER, 'from-metadata'), 'from-metadata');
  assert.equal(await resolveUserId(asClient(db), CUSTOMER, null), USER);
  assert.equal(await resolveUserId(asClient(db), 'cus_UNKNOWN', null), null);
});

test('an unreadable entitlement row is treated as GRANDFATHERED', async () => {
  // The safe direction. A false positive understates what the customer loses; a
  // false negative tells 151 users we are taking away inboxes we promised them
  // permanently.
  const db = new FakeSupabase();
  db.seed('user_usage_entitlements', [{ user_id: USER, unlimited_inboxes: false }]);

  assert.equal(await isGrandfathered(asClient(db), USER), false);
  assert.equal(await isGrandfathered(asClient(db), null), true);
  db.failOnce('user_usage_entitlements', { message: 'timeout' });
  assert.equal(await isGrandfathered(asClient(db), USER), true);
});

// ---------------------------------------------------------------------------
// The kill switch.
// ---------------------------------------------------------------------------

test('BILLING_LIFECYCLE_EMAILS is read at CALL time, not captured at module load', () => {
  const original = process.env.BILLING_LIFECYCLE_EMAILS;
  try {
    delete process.env.BILLING_LIFECYCLE_EMAILS;
    assert.equal(lifecycleMode(), 'off', 'the default is off');
    assert.equal(lifecycleQueueingEnabled(), false);
    assert.equal(lifecycleSendingEnabled(), false);

    // The same function, in the same process, must see the change. A warm
    // lambda that captured this at import would keep answering "off" after the
    // switch was flipped, and the flip would look like it had worked.
    process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
    assert.equal(lifecycleMode(), 'queue_only');
    assert.equal(lifecycleQueueingEnabled(), true, 'queue_only still materialises sequences');
    assert.equal(lifecycleSendingEnabled(), false, 'queue_only sends NOTHING');

    process.env.BILLING_LIFECYCLE_EMAILS = 'ON';
    assert.equal(lifecycleMode(), 'on');
    assert.equal(lifecycleSendingEnabled(), true);

    // A typo must fail towards silence, never towards mailing customers.
    process.env.BILLING_LIFECYCLE_EMAILS = 'queue-only';
    assert.equal(lifecycleMode(), 'off');
    process.env.BILLING_LIFECYCLE_EMAILS = 'true';
    assert.equal(lifecycleMode(), 'off');
  } finally {
    if (original === undefined) delete process.env.BILLING_LIFECYCLE_EMAILS;
    else process.env.BILLING_LIFECYCLE_EMAILS = original;
  }
});

test('queue_only can say WHAT it would have sent, not just how many', () => {
  // The dispatcher composes the email in queue_only precisely so the report
  // carries the real subject line, and so a template that cannot compose shows
  // up during review rather than on the day the switch is flipped.
  const composed = composeBillingEmail('dunning_1', {
    planId: 'personal',
    amountCents: 500,
    currency: 'usd',
    declineCode: 'insufficient_funds',
  });
  assert.ok(composed);
  assert.equal(composed.subject, 'Your MCPEmails payment did not go through');

  // A win-back with no unsubscribe token composes to nothing, which in
  // queue_only surfaces as a null subject in the report rather than as silence.
  assert.equal(composeBillingEmail('winback_14', { planId: 'personal' }), null);
});

// ---------------------------------------------------------------------------
// The dispatcher: freshness, and the budget that has to answer cron.
// ---------------------------------------------------------------------------

function stripeStub(overrides: Partial<{
  invoice: Record<string, unknown>;
  subscription: Record<string, unknown>;
  paymentMethod: Record<string, unknown>;
  throws: boolean;
}> = {}): FreshnessStripe {
  const boom = async () => {
    throw new Error('stripe is unreachable');
  };
  return {
    invoices: { retrieve: overrides.throws ? boom : async () => overrides.invoice ?? {} },
    subscriptions: { retrieve: overrides.throws ? boom : async () => overrides.subscription ?? {} },
    paymentMethods: { retrieve: overrides.throws ? boom : async () => overrides.paymentMethod ?? {} },
  } as FreshnessStripe;
}

const dunningRow = { id: 1, template: 'dunning_3', scope_key: INVOICE };

test('a dunning row against an invoice that is now PAID is cancelled, not sent', async () => {
  // The single worst thing this feature can do is dun somebody after taking
  // their money. This is the last line of defence, and it does not depend on
  // having received any webhook.
  const fresh = await checkFreshness(
    stripeStub({ invoice: { status: 'paid', amount_remaining: 0 } }),
    dunningRow,
  );
  assert.deepEqual(fresh, { send: false, reason: 'payment_recovered' });
});

test('a zero balance counts as recovered even when the status has not caught up', async () => {
  const fresh = await checkFreshness(
    stripeStub({ invoice: { status: 'open', amount_remaining: 0, amount_due: 500 } }),
    dunningRow,
  );
  assert.deepEqual(fresh, { send: false, reason: 'payment_recovered' });
});

test('a voided or uncollectible invoice is no longer due', async () => {
  for (const status of ['void', 'uncollectible']) {
    const fresh = await checkFreshness(stripeStub({ invoice: { status } }), dunningRow);
    assert.deepEqual(fresh, { send: false, reason: 'no_longer_due' }, status);
  }
});

test('a still-open invoice with money outstanding is sent', async () => {
  const fresh = await checkFreshness(
    stripeStub({ invoice: { status: 'open', amount_remaining: 500 } }),
    dunningRow,
  );
  assert.deepEqual(fresh, { send: true });
});

test('a Stripe read failure is NOT permission to send', async () => {
  const fresh = await checkFreshness(stripeStub({ throws: true }), dunningRow);
  assert.deepEqual(fresh, { send: false, reason: RETRY_REASON });
});

test('the cancellation question is dropped if they un-cancelled first', async () => {
  const row = { id: 2, template: 'cancel_ask', scope_key: `${SUBSCRIPTION}:1790718901` };
  assert.deepEqual(
    await checkFreshness(
      stripeStub({ subscription: { status: 'active', cancel_at_period_end: false } }),
      row,
    ),
    { send: false, reason: 'subscription_reactivated' },
    'never ask a paying customer why they left',
  );
  assert.deepEqual(
    await checkFreshness(
      stripeStub({ subscription: { status: 'active', cancel_at_period_end: true } }),
      row,
    ),
    { send: true },
  );
});

test('a win-back is dropped the moment they are paying again', async () => {
  const row = { id: 3, template: 'winback_14', scope_key: `${SUBSCRIPTION}:1790718901` };
  for (const status of ['active', 'trialing']) {
    assert.deepEqual(
      await checkFreshness(stripeStub({ subscription: { status } }), row),
      { send: false, reason: 'subscription_reactivated' },
      status,
    );
  }
  assert.deepEqual(
    await checkFreshness(stripeStub({ subscription: { status: 'canceled' } }), row),
    { send: true },
  );
});

test('a card-expiry warning is dropped once that card is gone or replaced', async () => {
  const row = { id: 4, template: 'card_expiry_30', scope_key: 'pm_A:10/2026' };

  assert.deepEqual(
    await checkFreshness(stripeStub({ paymentMethod: { customer: null } }), row),
    { send: false, reason: 'card_replaced' },
    'detached from the customer',
  );
  assert.deepEqual(
    await checkFreshness(
      stripeStub({ paymentMethod: { customer: CUSTOMER, card: { exp_month: 11, exp_year: 2028 } } }),
      row,
    ),
    { send: false, reason: 'card_replaced' },
    'still attached, but a different expiry',
  );
  assert.deepEqual(
    await checkFreshness(
      stripeStub({ paymentMethod: { customer: CUSTOMER, card: { exp_month: 10, exp_year: 2026 } } }),
      row,
    ),
    { send: true },
  );
});

test('the budget always leaves room to answer cron', () => {
  // pg_net fires and forgets, so an unanswered run is not retried; it is simply
  // a tick that did nothing. The budget has to be strictly inside maxDuration
  // (60s on the route) with room for the row in flight plus the response.
  assert.ok(WALL_CLOCK_BUDGET_MS < 60_000, 'the budget fits inside maxDuration');
  assert.ok(60_000 - WALL_CLOCK_BUDGET_MS >= 10_000, 'and leaves a real margin');

  const started = 1_000_000;
  assert.equal(budgetExhausted(started, started), false, 'a fresh run does work');
  assert.equal(budgetExhausted(started, started + WALL_CLOCK_BUDGET_MS), false, 'the boundary is inclusive');
  assert.equal(budgetExhausted(started, started + WALL_CLOCK_BUDGET_MS + 1), true, 'and one past it yields');

  // Even a pathologically slow run answers: the loop can only take BATCH_SIZE
  // rows, and it re-checks the clock before every one of them.
  let now = started;
  let handled = 0;
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    if (budgetExhausted(started, now)) break;
    handled += 1;
    now += 5_000; // five seconds per row, far worse than reality
  }
  assert.ok(handled < BATCH_SIZE, 'a slow run yields rather than running past maxDuration');
  assert.ok(now - started < 60_000, 'and yields before the route is killed');
});

test('the claim budget is small enough that the next tick is never far away', () => {
  assert.ok(BATCH_SIZE > 0 && BATCH_SIZE <= 200, 'within what claim_billing_emails will grant');
});

// ---------------------------------------------------------------------------
// The observability panel's arithmetic.
//
// This is the one place in the feature that makes a CLAIM about revenue, so it
// gets tested harder than its size suggests: an over-counted "recovered" figure
// is a number that would be used to decide whether the whole thing was worth
// building.
// ---------------------------------------------------------------------------

function row(over: Partial<DunningRow> = {}): DunningRow {
  return {
    template: 'dunning_1',
    category: 'transactional',
    stripe_customer_id: CUSTOMER,
    scope_key: INVOICE,
    send_after: '2026-09-01T00:00:00.000Z',
    sent_at: null,
    cancelled_at: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    recipient: 'customer@example.com',
    payload: { amountCents: 500, currency: 'usd', planId: 'personal' },
    ...over,
  };
}

test('a sequence counts as recovered only when an email actually went out first', () => {
  const s = summariseDunning(
    [
      // Emailed on day 0, then the card worked. This one is ours to claim.
      row({ template: 'dunning_1', scope_key: 'in_A', sent_at: '2026-09-01T01:00:00.000Z' }),
      row({ template: 'dunning_3', scope_key: 'in_A', cancelled_at: '2026-09-02T00:00:00.000Z', cancel_reason: 'payment_recovered' }),
      // Stripe's retry worked before we sent anything. NOT ours.
      row({ template: 'dunning_1', scope_key: 'in_B', cancelled_at: '2026-09-01T00:30:00.000Z', cancel_reason: 'payment_recovered' }),
      row({ template: 'dunning_3', scope_key: 'in_B', cancelled_at: '2026-09-01T00:30:00.000Z', cancel_reason: 'payment_recovered' }),
    ],
    new Date('2026-09-05T00:00:00.000Z'),
  );

  assert.equal(s.recovery.recoveredAfterEmail, 1);
  assert.equal(s.recovery.recoveredBeforeEmail, 1);
  assert.equal(s.recovery.emailed, 1);
  // One invoice, counted once, at the amount on the sequence rather than the
  // sum of its four rows.
  assert.equal(s.recovery.recoveredCents, 500);
});

test('a sequence that was emailed and never recovered is counted as emailed, not as revenue', () => {
  const s = summariseDunning([
    row({ template: 'dunning_1', sent_at: '2026-09-01T01:00:00.000Z' }),
    row({ template: 'dunning_14', cancelled_at: '2026-09-14T00:00:00.000Z', cancel_reason: 'subscription_deleted' }),
  ]);
  assert.equal(s.recovery.emailed, 1);
  assert.equal(s.recovery.recoveredAfterEmail, 0);
  assert.equal(s.recovery.recoveredCents, 0);
});

test('win-backs and card warnings never enter the recovered-revenue figure', () => {
  const s = summariseDunning([
    row({ template: 'winback_14', scope_key: 'sub_X:1', sent_at: '2026-09-01T00:00:00.000Z' }),
    row({ template: 'card_expiry_30', scope_key: 'pm_A:10/2026', sent_at: '2026-09-01T00:00:00.000Z' }),
    row({ template: 'cancel_ask', scope_key: 'sub_X:1', cancel_reason: 'payment_recovered', cancelled_at: '2026-09-02T00:00:00.000Z' }),
  ]);
  assert.equal(s.recovery.emailed, 0, 'only the four dunning templates are a dunning sequence');
  assert.equal(s.recovery.recoveredAfterEmail, 0);
  assert.equal(s.states.sent, 2);
});

test('due counts only rows whose send_after has actually arrived', () => {
  const s = summariseDunning(
    [
      row({ send_after: '2026-09-01T00:00:00.000Z' }),
      row({ template: 'dunning_3', send_after: '2026-09-04T00:00:00.000Z' }),
      row({ template: 'dunning_14', send_after: '2026-09-15T00:00:00.000Z' }),
    ],
    new Date('2026-09-05T00:00:00.000Z'),
  );
  assert.equal(s.states.pending, 3);
  assert.equal(s.states.due, 2);
});

test('a row that has burned its five attempts is surfaced as needing a person', () => {
  const s = summariseDunning([
    row({ attempts: 5, last_error: 'rate_limit_exceeded' }),
    row({ template: 'dunning_3', attempts: 2, last_error: 'timeout' }),
  ]);
  assert.equal(s.states.failing, 2, 'both have failed at least once');
  assert.equal(s.stuck.length, 1, 'only the one nothing will retry again');
  assert.equal(s.stuck[0].template, 'dunning_1');
  assert.equal(s.stuck[0].lastError, 'rate_limit_exceeded');
});

test('cancellations are split by reason, so a suppression cannot hide inside a success', () => {
  const s = summariseDunning([
    row({ cancelled_at: 'x', cancel_reason: 'payment_recovered' }),
    row({ template: 'dunning_3', cancelled_at: 'x', cancel_reason: 'payment_recovered' }),
    row({ template: 'winback_14', scope_key: 'sub_X:1', cancelled_at: 'x', cancel_reason: 'suppressed' }),
  ]);
  assert.deepEqual(s.cancelReasons, [
    { reason: 'payment_recovered', count: 2 },
    { reason: 'suppressed', count: 1 },
  ]);
});

test('an address is masked enough to recognise and not enough to harvest', () => {
  assert.equal(maskAddress('asgeir@mcpemails.com'), 'a****r@mcpemails.com');
  assert.equal(maskAddress('jo@example.com'), 'j****@example.com');
  assert.equal(maskAddress('not-an-address'), '****');
});

test('the last send is the most recent one, not the last row read', () => {
  const s = summariseDunning([
    row({ sent_at: '2026-09-03T00:00:00.000Z' }),
    row({ template: 'dunning_3', sent_at: '2026-09-01T00:00:00.000Z' }),
  ]);
  assert.equal(s.lastSentAt, '2026-09-03T00:00:00.000Z');
});
