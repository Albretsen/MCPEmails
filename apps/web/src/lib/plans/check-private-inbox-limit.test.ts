// ---------------------------------------------------------------------------
// The per-person private mailbox cap of Business billed per person (10 per
// person per workspace). Capped only with the switch on AND a seat-priced
// subscription; a flat $39 / founder Business is never capped here; every
// failed read lets the connect through.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/plans/check-private-inbox-limit.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY = 'price_seat_month';
process.env.STRIPE_PRICE_BUSINESS_SEAT_YEARLY = 'price_seat_year';

const { checkPrivateInboxLimit } = await import('./check-private-inbox-limit.ts');

function fakeDb(opts: { plan?: string; privateCount?: number; countError?: boolean }) {
  const filters: Array<[string, unknown]> = [];
  const db = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, value: unknown) => {
          if (table === 'inboxes') filters.push([col, value]);
          return builder;
        },
        maybeSingle: async () =>
          table === 'workspaces'
            ? { data: { owner_id: 'owner' }, error: null }
            : { data: { plan: opts.plan ?? 'pro', stripe_subscription_id: 'sub_1' }, error: null },
        is: async () =>
          opts.countError
            ? { count: null, error: { message: 'boom' } }
            : { count: opts.privateCount ?? 0, error: null },
      });
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, filters };
}

const stripeOn = (price: string) =>
  ({
    subscriptions: { retrieve: async () => ({ items: { data: [{ id: 'si', price: { id: price } }] } }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const args = (db: unknown, extra: Record<string, unknown> = {}) => ({
  db: db as never,
  workspaceId: 'ws1',
  userId: 'person',
  stripe: stripeOn('price_seat_month'),
  switchOn: true,
  ...extra,
});

test('per-person Business: the tenth private mailbox is the last one', async () => {
  const nine = await checkPrivateInboxLimit(args(fakeDb({ privateCount: 9 }).db));
  assert.deepEqual(nine, { atLimit: false, currentCount: 9, maxPrivateInboxes: 10 });
  const ten = await checkPrivateInboxLimit(args(fakeDb({ privateCount: 10 }).db));
  assert.deepEqual(ten, { atLimit: true, currentCount: 10, maxPrivateInboxes: 10 });
});

test('counts only this person\'s private, live mailboxes in this workspace', async () => {
  const { db, filters } = fakeDb({ privateCount: 3 });
  await checkPrivateInboxLimit(args(db));
  assert.deepEqual(filters, [
    ['workspace_id', 'ws1'],
    ['owner_user_id', 'person'],
    ['visibility', 'private'],
  ]);
});

test('no cap: switch off, not Business, a flat Business price, or a failed read', async () => {
  const none = { atLimit: false, currentCount: 0, maxPrivateInboxes: null };
  assert.deepEqual(await checkPrivateInboxLimit(args(fakeDb({ privateCount: 50 }).db, { switchOn: false })), none);
  assert.deepEqual(await checkPrivateInboxLimit(args(fakeDb({ plan: 'solo', privateCount: 50 }).db)), none);
  assert.deepEqual(
    await checkPrivateInboxLimit(args(fakeDb({ privateCount: 50 }).db, { stripe: stripeOn('price_business_month') })),
    none,
  );
  assert.deepEqual(await checkPrivateInboxLimit(args(fakeDb({ countError: true }).db)), none);
  const original = console.error;
  console.error = () => {};
  try {
    const broken = {
      subscriptions: { retrieve: async () => { throw new Error('stripe down'); } },
    };
    assert.deepEqual(await checkPrivateInboxLimit(args(fakeDb({ privateCount: 50 }).db, { stripe: broken })), none);
  } finally {
    console.error = original;
  }
});
