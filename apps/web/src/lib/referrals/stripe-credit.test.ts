import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clawbackReferralCredit,
  issueReferralCredit,
  monthlyListPriceCents,
  type ReferralStripe,
} from './stripe-credit.ts';
import { PLANS } from '../stripe/plans.ts';

interface Call {
  customerId: string;
  params: { amount: number; currency: string; description?: string; metadata?: Record<string, string> };
  options: { idempotencyKey?: string };
}

function fakeStripe(balance: number | null, opts: { deleted?: boolean } = {}) {
  const calls: Call[] = [];
  const retrieved: string[] = [];
  const fake = {
    customers: {
      async createBalanceTransaction(customerId: string, params: Call['params'], options: Call['options']) {
        calls.push({ customerId, params, options });
        return { id: `cbtxn_${calls.length}` };
      },
      async retrieve(customerId: string) {
        retrieved.push(customerId);
        return opts.deleted ? { id: customerId, deleted: true } : { id: customerId, balance };
      },
    },
  };
  return { stripe: fake as unknown as ReferralStripe, calls, retrieved };
}

test('monthly list price per plan, from PLANS', () => {
  assert.equal(monthlyListPriceCents('personal'), PLANS.personal.monthlyPriceCents);
  assert.equal(monthlyListPriceCents('personal'), 900);
  assert.equal(monthlyListPriceCents('solo'), PLANS.solo.monthlyPriceCents);
  assert.equal(monthlyListPriceCents('pro'), 3900);
  assert.equal(monthlyListPriceCents('free'), null);
  assert.equal(monthlyListPriceCents('team'), null);
  assert.equal(monthlyListPriceCents('toString'), null);
  assert.equal(monthlyListPriceCents(''), null);
});

test('issueReferralCredit writes a negative USD balance transaction once per side', async () => {
  const { stripe, calls } = fakeStripe(0);
  const result = await issueReferralCredit(stripe, {
    customerId: 'cus_1',
    referralId: 'ref_1',
    side: 'friend',
    amountCents: 900,
  });
  assert.deepEqual(result, { id: 'cbtxn_1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    customerId: 'cus_1',
    params: {
      amount: -900,
      currency: 'usd',
      description: 'Referral reward: one free month',
      metadata: { referral_id: 'ref_1', side: 'friend', program: 'referral_v1' },
    },
    options: { idempotencyKey: 'referral:ref_1:friend' },
  });
});

test('issueReferralCredit refuses a non-positive or fractional amount', async () => {
  const { stripe, calls } = fakeStripe(0);
  for (const amountCents of [0, -900, 9.5, Number.NaN]) {
    await assert.rejects(
      issueReferralCredit(stripe, { customerId: 'cus_1', referralId: 'ref_1', side: 'referrer', amountCents }),
    );
  }
  assert.equal(calls.length, 0);
});

test('clawback takes back the full reward while the credit is unspent', async () => {
  const { stripe, calls } = fakeStripe(-1500);
  const result = await clawbackReferralCredit(stripe, {
    customerId: 'cus_2',
    referralId: 'ref_2',
    side: 'referrer',
    maxCents: 900,
  });
  assert.deepEqual(result, { id: 'cbtxn_1', amountCents: 900 });
  assert.deepEqual(calls[0].params, {
    amount: 900,
    currency: 'usd',
    description: 'Referral reward reversed',
    metadata: { referral_id: 'ref_2', side: 'clawback_referrer', program: 'referral_v1' },
  });
  assert.deepEqual(calls[0].options, { idempotencyKey: 'referral:ref_2:clawback_referrer' });
});

test('clawback is capped at the remaining credit', async () => {
  const { stripe, calls } = fakeStripe(-300);
  const result = await clawbackReferralCredit(stripe, {
    customerId: 'cus_3',
    referralId: 'ref_3',
    side: 'friend',
    maxCents: 900,
  });
  assert.deepEqual(result, { id: 'cbtxn_1', amountCents: 300 });
  assert.equal(calls[0].params.amount, 300);
  assert.equal(calls[0].options.idempotencyKey, 'referral:ref_3:clawback_friend');
});

test('clawback writes nothing when no credit is left', async () => {
  for (const balance of [0, 500, null]) {
    const { stripe, calls } = fakeStripe(balance);
    const result = await clawbackReferralCredit(stripe, {
      customerId: 'cus_4',
      referralId: 'ref_4',
      side: 'referrer',
      maxCents: 900,
    });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  }
  const deleted = fakeStripe(-900, { deleted: true });
  assert.equal(
    await clawbackReferralCredit(deleted.stripe, { customerId: 'cus_5', referralId: 'ref_5', side: 'friend', maxCents: 900 }),
    null,
  );
  assert.equal(deleted.calls.length, 0);
  const zero = fakeStripe(-900);
  assert.equal(
    await clawbackReferralCredit(zero.stripe, { customerId: 'cus_6', referralId: 'ref_6', side: 'friend', maxCents: 0 }),
    null,
  );
  assert.deepEqual(zero.retrieved, []);
});
