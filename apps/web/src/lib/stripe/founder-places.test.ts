// ---------------------------------------------------------------------------
// The server half of the Business founder price: the offer lookup (flag,
// count, owner; cached; fails closed) and the webhook writer of
// business_founder_places (paid founder subscriptions only, idempotent,
// tagged, never a test-mode row under a live key).
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/founder-places.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY = 'price_founder_month';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_YEARLY = 'price_founder_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';

const { currentFounderOffer, resetFounderOfferCaches } = await import('./founder-offer-server.ts');
const { recordFounderPlace } = await import('./founder-places.ts');

const OPEN = new Date('2026-11-20T12:00:00Z');
const OWNER = '00000000-0000-0000-0000-0000000000a1';

type Answer = { data?: unknown; count?: number | null; error?: { message: string } | null };

/** A service-role stub that answers the three reads and counts them. */
function fakeDb(opts: { flag?: Answer; count?: Answer; owner?: Answer }) {
  const reads = { flag: 0, count: 0, owner: 0 };
  const db = {
    from(table: string) {
      let kind: 'flag' | 'count' | 'owner' = table === 'pricing_switches' ? 'flag' : 'owner';
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: (_cols: string, o?: { head?: boolean }) => {
          if (table === 'business_founder_places' && o?.head) kind = 'count';
          if (kind === 'count') {
            reads.count += 1;
            return Promise.resolve({ count: 0, error: null, ...opts.count });
          }
          return builder;
        },
        eq: () => builder,
        maybeSingle: async () => {
          reads.flag += 1;
          return { data: { enabled: true }, error: null, ...opts.flag };
        },
        limit: async () => {
          reads.owner += 1;
          return { data: [], error: null, ...opts.owner };
        },
      });
      return builder;
    },
  };
  return { db: db as never, reads };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('flag on, places open, new owner: an offer', async () => {
  resetFounderOfferCaches();
  const { db } = fakeDb({ count: { count: 6 } });
  const offer = await currentFounderOffer({ db, ownerId: OWNER, now: OPEN });
  assert.equal(offer?.placesLeft, 14);
  assert.equal(offer?.monthlyPriceId, 'price_founder_month');
});

test('flag off: no offer', async () => {
  resetFounderOfferCaches();
  const { db } = fakeDb({ flag: { data: { enabled: false } } });
  assert.equal(await currentFounderOffer({ db, now: OPEN }), null);
});

test('a missing flag row is off', async () => {
  resetFounderOfferCaches();
  const { db } = fakeDb({ flag: { data: null } });
  assert.equal(await currentFounderOffer({ db, now: OPEN }), null);
});

test('one per owner: an owner with a row gets no offer', async () => {
  resetFounderOfferCaches();
  const { db } = fakeDb({ owner: { data: [{ stripe_subscription_id: 'sub_1' }] } });
  assert.equal(await currentFounderOffer({ db, ownerId: OWNER, now: OPEN }), null);
});

test('every read fails closed', async () => {
  for (const failing of ['flag', 'count', 'owner'] as const) {
    resetFounderOfferCaches();
    const { db } = fakeDb({ [failing]: { error: { message: 'boom' } } });
    assert.equal(
      await quiet(() => currentFounderOffer({ db, ownerId: OWNER, now: OPEN })),
      null,
      `${failing} failure must hide the offer`,
    );
  }
});

test('outside the window nothing is read at all', async () => {
  resetFounderOfferCaches();
  const { db, reads } = fakeDb({});
  assert.equal(await currentFounderOffer({ db, now: new Date('2026-10-24T12:00:00Z') }), null);
  assert.equal(await currentFounderOffer({ db, now: new Date('2027-01-01T00:00:00Z') }), null);
  assert.deepEqual(reads, { flag: 0, count: 0, owner: 0 });
});

test('the flag is cached at most 60 s and the count at most 5 min', async () => {
  resetFounderOfferCaches();
  const { db, reads } = fakeDb({});
  await currentFounderOffer({ db, now: OPEN });
  await currentFounderOffer({ db, now: new Date(OPEN.getTime() + 59_000) });
  assert.equal(reads.flag, 1);
  assert.equal(reads.count, 1);
  await currentFounderOffer({ db, now: new Date(OPEN.getTime() + 61_000) });
  assert.equal(reads.flag, 2);
  assert.equal(reads.count, 1);
  await currentFounderOffer({ db, now: new Date(OPEN.getTime() + 301_000) });
  assert.equal(reads.count, 2);
});

// ── The webhook writer ───────────────────────────────────────────────────

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_founder_1',
    status: 'active',
    livemode: true,
    metadata: { user_id: OWNER },
    items: {
      data: [
        { price: { id: 'price_addon_month' } },
        { price: { id: 'price_founder_month' } },
      ],
    },
    ...overrides,
  } as never;
}

function writerDb(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    db: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return answer;
      },
    } as never,
  };
}

test('a paid founder subscription takes a place and is tagged', async () => {
  const { db, calls } = writerDb({ data: true, error: null });
  const tags: Array<[string, Record<string, string>]> = [];
  const result = await recordFounderPlace({
    db,
    subscription: subscription(),
    ownerId: OWNER,
    tagSubscription: async (id, metadata) => tags.push([id, metadata]),
  });
  assert.deepEqual(result, { status: 'recorded', inserted: true });
  assert.deepEqual(calls, [
    {
      fn: 'record_business_founder_place',
      args: { p_subscription_id: 'sub_founder_1', p_owner_id: OWNER, p_interval: 'month' },
    },
  ]);
  assert.deepEqual(tags, [['sub_founder_1', { offer: 'founder2026' }]]);
});

test('a retried event writes nothing new and does not re-tag a tagged subscription', async () => {
  const { db } = writerDb({ data: false, error: null });
  const tags: unknown[] = [];
  const result = await recordFounderPlace({
    db,
    subscription: subscription({ metadata: { user_id: OWNER, offer: 'founder2026' } }),
    ownerId: OWNER,
    tagSubscription: async (...args) => tags.push(args),
  });
  assert.deepEqual(result, { status: 'recorded', inserted: false });
  assert.equal(tags.length, 0);
});

test('the yearly founder price records interval year', async () => {
  const { db, calls } = writerDb({ data: true, error: null });
  await recordFounderPlace({
    db,
    subscription: subscription({ items: { data: [{ price: { id: 'price_founder_year' } }] } }),
    ownerId: OWNER,
    tagSubscription: async () => {},
  });
  assert.equal(calls[0].args.p_interval, 'year');
});

test('not founder, not paid, no owner: nothing is written', async () => {
  const cases: Array<[Record<string, unknown>, string | null, string]> = [
    [{ items: { data: [{ price: { id: 'price_business_month' } }] } }, OWNER, 'not_founder'],
    [{ status: 'incomplete' }, OWNER, 'not_paid'],
    [{ status: 'past_due' }, OWNER, 'not_paid'],
    [{}, null, 'no_owner'],
  ];
  for (const [overrides, ownerId, reason] of cases) {
    const { db, calls } = writerDb({ data: true, error: null });
    const result = await recordFounderPlace({
      db,
      subscription: subscription(overrides),
      ownerId,
      tagSubscription: async () => {},
    });
    assert.deepEqual(result, { status: 'skipped', reason });
    assert.equal(calls.length, 0);
  }
});

test('a test-mode event never writes where the live key is in use', async () => {
  const before = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_live_unit_test_only';
  try {
    const { db, calls } = writerDb({ data: true, error: null });
    const result = await recordFounderPlace({
      db,
      subscription: subscription({ livemode: false }),
      ownerId: OWNER,
      tagSubscription: async () => {},
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'test_mode_event' });
    assert.equal(calls.length, 0);
  } finally {
    if (before === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = before;
  }
});

test('a database failure is reported, never thrown', async () => {
  const { db } = writerDb({ data: null, error: { message: 'down' } });
  const result = await quiet(() =>
    recordFounderPlace({ db, subscription: subscription(), ownerId: OWNER, tagSubscription: async () => {} }),
  );
  assert.deepEqual(result, { status: 'failed' });
});
