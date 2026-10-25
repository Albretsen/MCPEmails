// ---------------------------------------------------------------------------
// The Stripe webhook, end to end through POST, for the referral program.
//
//   - the friend's first paid subscription invoice moves 'attached' to
//     'charged' with the invoice, the charge, the time and qualifies_at;
//   - renewals, small charges, strangers and a referrer with the flag off
//     change nothing, and a redelivery changes nothing twice;
//   - a refund or dispute before qualification voids; a dispute or full
//     refund after it claws back the unspent credit once; a partial refund
//     after it claws back nothing;
//   - a referral failure never fails the invoice event.
//
// Same stubbing as route.plan-limit-pause.test.ts: only the I/O is faked, and
// the database is the stateful fake from src/lib/billing/fake-supabase.ts.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { FakeStripe } from '@/lib/referrals/fake-stripe';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_referral_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'off';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();
let fake = new FakeStripe();

function ledgerTable() {
  let outcome: { data: unknown; error: { code: string; message: string } | null } = { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'gt', 'limit', 'delete']) builder[name] = () => builder;
  builder.insert = (row: { event_id: string }) => {
    if (ledger.has(row.event_id)) {
      outcome = { data: null, error: { code: '23505', message: 'duplicate key' } };
    } else {
      ledger.add(row.event_id);
      outcome = { data: { event_id: row.event_id }, error: null };
    }
    return builder;
  };
  builder.maybeSingle = async () => outcome;
  builder.then = (resolve: (value: unknown) => unknown) => resolve(outcome);
  return builder;
}

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => (table === 'stripe_webhook_events' ? ledgerTable() : db.from(table)),
      rpc: (fn: string, args?: Record<string, unknown>) => db.rpc(fn, args),
    }),
  },
});

const webhooks = { constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')) };
// One stable object for the route's module-scope import; each test swaps `fake`.
const stripeProxy = new Proxy({}, {
  get: (_target, prop: string) => (prop === 'webhooks' ? webhooks : (fake.api() as unknown as Record<string, unknown>)[prop]),
});
nodeMock.module('@/lib/stripe/client', { namedExports: { stripe: stripeProxy } });

nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
    after: () => undefined,
  },
});

const { POST } = await import('./route.ts');

const REFERRER = '00000000-0000-4000-8000-0000000000a1';
const FRIEND = '00000000-0000-4000-8000-0000000000b2';
const PAID_AT = 1_793_000_000; // 2026-10-26T...Z

function seed(options: { flag?: boolean; status?: string } = {}) {
  db = new FakeSupabase();
  db.unique('referral_rewards', ['referral_id', 'side']);
  ledger = new Set();
  fake = new FakeStripe();
  db.seed('workspaces', [
    { id: 'ws-referrer', owner_id: REFERRER, plan: 'solo', referral_enabled: options.flag ?? true, deleted_at: null },
    { id: 'ws-friend', owner_id: FRIEND, plan: 'free', referral_enabled: false, deleted_at: null },
  ]);
  db.seed('user_billing', [{ user_id: FRIEND, plan: 'personal', stripe_customer_id: 'cus_friend', stripe_subscription_id: 'sub_friend', subscription_status: 'active' }]);
  db.seed('referrals', [{
    id: 'ref-1',
    code: 'ABCD2345',
    referrer_user_id: REFERRER,
    friend_user_id: FRIEND,
    friend_workspace_id: 'ws-friend',
    status: options.status ?? 'attached',
    first_charge_id: options.status && options.status !== 'attached' ? 'ch_first' : null,
    ip_hash: 'h',
  }]);
}

const referral = () => db.table('referrals')[0];
let seq = 0;

async function deliver(type: string, object: Record<string, unknown>, id?: string) {
  seq += 1;
  const event = { id: id ?? `evt_referral_${seq}`, type, created: 1_793_000_000 + seq, data: { object } };
  const res = await POST(new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  }) as unknown as Parameters<typeof POST>[0]);
  return res.status;
}

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'in_first',
    customer: 'cus_friend',
    billing_reason: 'subscription_create',
    amount_paid: 900,
    charge: 'ch_first',
    status_transitions: { paid_at: PAID_AT },
    parent: { subscription_details: { metadata: { user_id: FRIEND } } },
    ...over,
  };
}

test('the first paid invoice moves the referral to charged with qualifies_at 14 days on', async () => {
  seed();
  assert.equal(await deliver('invoice.payment_succeeded', invoice()), 200);
  const r = referral();
  assert.equal(r.status, 'charged');
  assert.equal(r.first_invoice_id, 'in_first');
  assert.equal(r.first_charge_id, 'ch_first');
  assert.equal(r.first_charge_at, new Date(PAID_AT * 1000).toISOString());
  assert.equal(r.qualifies_at, new Date((PAID_AT + 14 * 86_400) * 1000).toISOString());
  assert.deepEqual(db.table('product_funnel_events').map((e) => [e.stage, e.workspace_id]), [['referral_charged', 'ws-friend']]);
});

test('the charge is found under invoice.payments on the current API shape', async () => {
  seed();
  fake.invoicePayments.set('in_first', 'ch_from_payments');
  const { charge: _drop, parent: _p, ...current } = invoice();
  // No metadata either: the friend is resolved through user_billing.
  assert.equal(await deliver('invoice.payment_succeeded', current), 200);
  assert.equal(referral().status, 'charged');
  assert.equal(referral().first_charge_id, 'ch_from_payments');
});

test('renewals, small charges, strangers and a flag-off referrer change nothing', async () => {
  for (const [name, options, over] of [
    ['renewal', {}, { billing_reason: 'subscription_cycle' }],
    ['under 5 USD', {}, { amount_paid: 499 }],
    ['someone else', {}, { customer: 'cus_stranger', parent: { subscription_details: { metadata: { user_id: 'someone-else' } } } }],
    ['flag off', { flag: false }, {}],
  ] as const) {
    seed(options);
    assert.equal(await deliver('invoice.payment_succeeded', invoice(over)), 200, name);
    assert.equal(referral().status, 'attached', name);
  }
});

test('a redelivered first invoice is a no-op the second time', async () => {
  seed();
  await deliver('invoice.payment_succeeded', invoice(), 'evt_same');
  const first = { ...referral() };
  await deliver('invoice.payment_succeeded', invoice({ status_transitions: { paid_at: PAID_AT + 999 } }), 'evt_other');
  assert.deepEqual(referral(), first);
});

test('a referral failure never fails the invoice event', async () => {
  seed();
  db.failTimes('referrals', { message: 'down' }, 3);
  assert.equal(await deliver('invoice.payment_succeeded', invoice()), 200);
});

test('a refund or a dispute before qualification voids the referral', async () => {
  for (const [type, object, reason] of [
    ['charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 900, refunded: true }, 'refunded'],
    ['charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 100, refunded: false }, 'partially_refunded'],
    ['charge.dispute.created', { id: 'dp_1', charge: 'ch_first' }, 'disputed'],
  ] as const) {
    seed({ status: 'charged' });
    assert.equal(await deliver(type, object), 200);
    assert.equal(referral().status, 'voided', reason);
    assert.equal(referral().void_reason, reason);
    assert.equal(referral().ip_hash, null);
  }
});

function rewarded(currency = 'usd') {
  seed({ status: 'qualified' });
  fake.customer('cus_referrer', { balance: -1500 });
  fake.customer('cus_friend', { balance: -400 });
  db.seed('referral_rewards', [
    { referral_id: 'ref-1', side: 'referrer', kind: 'stripe_credit', amount_cents: 1500, currency, stripe_customer_id: 'cus_referrer', stripe_balance_txn_id: 'cbtxn_r' },
    { referral_id: 'ref-1', side: 'friend', kind: 'stripe_credit', amount_cents: 900, currency, stripe_customer_id: 'cus_friend', stripe_balance_txn_id: 'cbtxn_f' },
  ]);
}

test('a dispute after qualification claws back only the unspent credit, once', async () => {
  rewarded();
  assert.equal(await deliver('charge.dispute.created', { id: 'dp_1', charge: 'ch_first' }), 200);
  assert.equal(fake.balances.get('cus_referrer'), 0);
  assert.equal(fake.balances.get('cus_friend'), 0, 'only the 400 left is taken, never more');
  const clawbacks = db.table('referral_rewards').filter((r) => String(r.side).startsWith('clawback_'));
  assert.deepEqual(clawbacks.map((r) => [r.side, r.amount_cents]).sort(), [['clawback_friend', 400], ['clawback_referrer', 1500]]);
  assert.equal(referral().status, 'voided');
  assert.equal(referral().void_reason, 'disputed_after_reward');

  // A second dispute event for the same charge takes nothing more.
  assert.equal(await deliver('charge.dispute.created', { id: 'dp_2', charge: 'ch_first' }), 200);
  assert.equal(fake.txns.length, 2);
});

test('a partial refund after qualification claws back nothing', async () => {
  rewarded();
  assert.equal(await deliver('charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 200, refunded: false }), 200);
  assert.equal(fake.txns.length, 0);
  assert.equal(referral().status, 'qualified');
});

test('a full refund after qualification claws back', async () => {
  rewarded();
  assert.equal(await deliver('charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 900, refunded: true }), 200);
  assert.equal(fake.balances.get('cus_referrer'), 0);
  assert.equal(referral().void_reason, 'refunded_after_reward');
});

test('a clawback is written in the currency its reward was issued in', async () => {
  rewarded('eur');
  assert.equal(await deliver('charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 900, refunded: true }), 200);
  assert.deepEqual(fake.txns.map((t) => t.currency), ['eur', 'eur']);
  const clawbacks = db.table('referral_rewards').filter((r) => String(r.side).startsWith('clawback_'));
  assert.deepEqual(clawbacks.map((r) => r.currency), ['eur', 'eur']);
});

test('a reward in a currency we do not credit in is left for a person, not clawed back', async () => {
  rewarded('gbp');
  assert.equal(await deliver('charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 900, refunded: true }), 200);
  assert.equal(fake.txns.length, 0);
  assert.equal(referral().void_reason, 'refunded_after_reward');
});

test('a refund landing while the dispatcher is rewarding voids the row and takes back what was already issued', async () => {
  // The dispatcher read the charge before the refund and issued the referrer
  // credit; the row is still 'charged' when the refund arrives.
  seed({ status: 'charged' });
  fake.customer('cus_referrer', { balance: -1500 });
  db.seed('referral_rewards', [
    { referral_id: 'ref-1', side: 'referrer', kind: 'stripe_credit', amount_cents: 1500, currency: 'usd', stripe_customer_id: 'cus_referrer', stripe_balance_txn_id: 'cbtxn_r' },
    // Claimed, not yet issued: the dispatcher takes this one back itself.
    { referral_id: 'ref-1', side: 'friend', kind: 'stripe_credit', amount_cents: 900, currency: 'usd', stripe_customer_id: 'cus_friend', stripe_balance_txn_id: null },
  ]);
  assert.equal(await deliver('charge.refunded', { id: 'ch_first', customer: 'cus_friend', amount: 900, amount_refunded: 900, refunded: true }), 200);
  assert.equal(referral().status, 'voided');
  assert.equal(referral().void_reason, 'refunded');
  assert.equal(fake.balances.get('cus_referrer'), 0);
  assert.deepEqual(
    db.table('referral_rewards').filter((r) => String(r.side).startsWith('clawback_')).map((r) => [r.side, r.amount_cents]),
    [['clawback_referrer', 1500]],
  );
});

test('a clawback retried after Stripe answered records the earlier reversal instead of failing', async () => {
  rewarded();
  // A first delivery reversed the referrer credit in Stripe, then lost the row.
  fake.balances.set('cus_referrer', 0);
  fake.txns.push({ id: 'cbtxn_claw_earlier', customer: 'cus_referrer', amount: 1500, currency: 'usd', metadata: { referral_id: 'ref-1', side: 'clawback_referrer', program: 'referral_v1' } });
  assert.equal(await deliver('charge.dispute.created', { id: 'dp_1', charge: 'ch_first' }), 200);
  const claw = db.table('referral_rewards').find((r) => r.side === 'clawback_referrer');
  assert.equal(claw?.stripe_balance_txn_id, 'cbtxn_claw_earlier');
  assert.equal(claw?.amount_cents, 1500);
  assert.equal(fake.txns.filter((t) => t.customer === 'cus_referrer').length, 1, 'no second reversal');
  assert.equal(referral().void_reason, 'disputed_after_reward');
});

test('a refund on a charge no referral knows is acknowledged and ignored', async () => {
  seed({ status: 'charged' });
  assert.equal(await deliver('charge.refunded', { id: 'ch_other', customer: 'cus_friend', amount: 900, amount_refunded: 900, refunded: true }), 200);
  assert.equal(referral().status, 'charged');
});

test('both charge events are exempt from the staleness guard', async () => {
  // The guard skips a non-exempt event older than the newest one for the
  // customer, which a refund next to a cancellation often is. The fake ledger
  // never reports a newer event, so this pins the exemption list itself.
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('./route.ts', import.meta.url), 'utf8'));
  const exempt = source.slice(source.indexOf('EXEMPT_FROM_STALENESS'), source.indexOf(']);', source.indexOf('EXEMPT_FROM_STALENESS')));
  assert.ok(exempt.includes("'charge.refunded'"));
  assert.ok(exempt.includes("'charge.dispute.created'"));
});
