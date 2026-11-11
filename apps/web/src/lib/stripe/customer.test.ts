// ---------------------------------------------------------------------------
// One Stripe customer per user, and no empty ones left behind.
//
//   1. A user with a saved customer reuses it; Stripe is not called.
//   2. A request that loses the save race deletes the customer it made.
//   3. A customer that cannot be saved is deleted before the error surfaces.
//   4. discardNewStripeCustomer clears the row and deletes the customer, but
//      only while the row still names it and has no subscription.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/stripe/customer.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module(specifier: string, options: { namedExports: Record<string, unknown> }): void;
};

const USER = '00000000-0000-0000-0000-0000000000c1';

let savedBefore: string | null = null;
let savedAfter: string | null = null;
let upsertError: { message: string } | null = null;
let updateMatches = true;
const created: string[] = [];
const deleted: string[] = [];
const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, string, unknown]> }> = [];
let reads = 0;
let nextId = 1;

function reset() {
  savedBefore = null;
  savedAfter = null;
  upsertError = null;
  updateMatches = true;
  created.length = 0;
  deleted.length = 0;
  updates.length = 0;
  reads = 0;
}

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      customers: {
        create: async () => {
          const id = `cus_new_${nextId++}`;
          created.push(id);
          return { id };
        },
        del: async (id: string) => {
          deleted.push(id);
          return { id, deleted: true };
        },
      },
    },
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: () => {
        const filters: Array<[string, string, unknown]> = [];
        let pendingUpdate: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), b),
          is: (c: string, v: unknown) => (filters.push(['is', c, v]), b),
          maybeSingle: async () => {
            reads += 1;
            const id = reads === 1 ? savedBefore : savedAfter;
            return { data: id ? { stripe_customer_id: id } : null, error: null };
          },
          upsert: async () => ({ error: upsertError }),
          update: (values: Record<string, unknown>) => ((pendingUpdate = values), b),
          then: (resolve: (v: unknown) => void) => {
            if (pendingUpdate) updates.push({ values: pendingUpdate, filters });
            return resolve({ data: updateMatches ? [{ user_id: USER }] : [], error: null });
          },
        };
        return b;
      },
    }),
  },
});

const { getOrCreateStripeCustomer, discardNewStripeCustomer } = await import('./customer.ts');
const opts = { userId: USER, ownerEmail: 'a@example.com', displayName: 'A' };

test('a saved customer is reused without calling Stripe', async () => {
  reset();
  savedBefore = 'cus_saved';
  assert.deepEqual(await getOrCreateStripeCustomer(opts), { customerId: 'cus_saved', created: false });
  assert.equal(created.length, 0);
});

test('a new customer is created and reported as created', async () => {
  reset();
  const r = await getOrCreateStripeCustomer(opts);
  assert.equal(r.created, true);
  assert.equal(r.customerId, created[0]);
  assert.equal(deleted.length, 0);
});

test('losing the save race deletes the customer this request made', async () => {
  reset();
  savedAfter = 'cus_winner';
  const r = await getOrCreateStripeCustomer(opts);
  assert.deepEqual(r, { customerId: 'cus_winner', created: false });
  assert.deepEqual(deleted, created);
});

test('a customer that cannot be saved is deleted, then the error surfaces', async () => {
  reset();
  upsertError = { message: 'db down' };
  await assert.rejects(getOrCreateStripeCustomer(opts), /could not be saved/);
  assert.deepEqual(deleted, created);
});

test('discard clears the row (only this customer, no subscription) and deletes it', async () => {
  reset();
  await discardNewStripeCustomer(USER, 'cus_x');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].values, { stripe_customer_id: null });
  assert.deepEqual(updates[0].filters, [
    ['eq', 'user_id', USER],
    ['eq', 'stripe_customer_id', 'cus_x'],
    ['is', 'stripe_subscription_id', null],
  ]);
  assert.deepEqual(deleted, ['cus_x']);
});

test('discard leaves the customer alone when the row moved on', async () => {
  reset();
  updateMatches = false;
  await discardNewStripeCustomer(USER, 'cus_x');
  assert.equal(deleted.length, 0);
});
