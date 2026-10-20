// Run: node --test --experimental-strip-types src/lib/stripe/cancel-on-account-delete.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_DELETED_CANCELLATION_COMMENT,
  cancelSubscriptionsForDeletedAccount,
  isAccountDeletionCancellation,
  type SubscriptionCanceller,
} from './cancel-on-account-delete.ts';

function fakeStripe(pages: Record<string, Array<Array<{ id: string; status: string }>>>) {
  const cancelled: string[] = [];
  const listed: Array<{ customer: string; starting_after?: string }> = [];
  const stripe: SubscriptionCanceller = {
    subscriptions: {
      async list(params) {
        listed.push({ customer: params.customer, starting_after: params.starting_after });
        const all = pages[params.customer] ?? [];
        const index = params.starting_after
          ? all.findIndex((p) => p.at(-1)?.id === params.starting_after) + 1
          : 0;
        return { data: all[index] ?? [], has_more: index < all.length - 1 };
      },
      async cancel(id) {
        cancelled.push(id);
        return { id, status: 'canceled' };
      },
    },
  };
  return { stripe, cancelled, listed };
}

test('cancels every status that can still bill, skips the ended ones', async () => {
  const { stripe, cancelled } = fakeStripe({
    cus_a: [
      [
        { id: 'sub_active', status: 'active' },
        { id: 'sub_trial', status: 'trialing' },
        { id: 'sub_due', status: 'past_due' },
        { id: 'sub_unpaid', status: 'unpaid' },
        { id: 'sub_paused', status: 'paused' },
        { id: 'sub_incomplete', status: 'incomplete' },
        { id: 'sub_done', status: 'canceled' },
        { id: 'sub_expired', status: 'incomplete_expired' },
      ],
    ],
  });
  const result = await cancelSubscriptionsForDeletedAccount(stripe, ['cus_a']);
  assert.deepEqual(result, [
    'sub_active',
    'sub_trial',
    'sub_due',
    'sub_unpaid',
    'sub_paused',
    'sub_incomplete',
  ]);
  assert.deepEqual(cancelled, result);
});

test('follows has_more across pages', async () => {
  const { stripe, cancelled, listed } = fakeStripe({
    cus_a: [[{ id: 'sub_1', status: 'canceled' }], [{ id: 'sub_2', status: 'active' }]],
  });
  await cancelSubscriptionsForDeletedAccount(stripe, ['cus_a']);
  assert.deepEqual(cancelled, ['sub_2']);
  assert.deepEqual(listed, [
    { customer: 'cus_a', starting_after: undefined },
    { customer: 'cus_a', starting_after: 'sub_1' },
  ]);
});

test('de-duplicates customers and ignores empty ids', async () => {
  const { stripe, listed } = fakeStripe({});
  await cancelSubscriptionsForDeletedAccount(stripe, ['cus_a', '', 'cus_a', 'cus_b']);
  assert.deepEqual(
    listed.map((l) => l.customer),
    ['cus_a', 'cus_b'],
  );
});

test('a Stripe error propagates so the caller can stop the deletion', async () => {
  const stripe: SubscriptionCanceller = {
    subscriptions: {
      list: async () => ({ data: [{ id: 'sub_1', status: 'active' }], has_more: false }),
      cancel: async () => {
        throw new Error('card_declined');
      },
    },
  };
  await assert.rejects(cancelSubscriptionsForDeletedAccount(stripe, ['cus_a']), /card_declined/);
});

test('the webhook recognises only its own cancellation marker', () => {
  assert.equal(
    isAccountDeletionCancellation({
      cancellation_details: { comment: ACCOUNT_DELETED_CANCELLATION_COMMENT },
    }),
    true,
  );
  assert.equal(isAccountDeletionCancellation({ cancellation_details: { comment: null } }), false);
  assert.equal(isAccountDeletionCancellation({ cancellation_details: null }), false);
  assert.equal(isAccountDeletionCancellation({}), false);
});
