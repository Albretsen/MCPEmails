// ---------------------------------------------------------------------------
// The Business per-mailbox add-on: quantity = max(0, mailboxes - 10), kept in
// step as mailboxes are connected and removed.
//
// The properties that cost a customer money if they break:
//   1. Adding past ten bills now (always_invoice); removing credits nothing
//      and lowers the quantity from the next renewal (proration 'none').
//   2. A repeated sync with nothing changed does not call Stripe at all.
//   3. Creating the add-on item carries an idempotency key, so two concurrent
//      first connects past ten cannot create two items, and the key changes
//      between creations, so an add-on removed and needed again is recreated
//      instead of Stripe replaying the old "created" response.
//   4. Only a live Business subscription is ever touched.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/mailbox-addon.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';

const { mailboxAddonCreateKey, mailboxAddonItemChanges, syncMailboxAddon, syncMailboxAddonForWorkspace } = await import(
  './mailbox-addon.ts'
);

const OWNER = '00000000-0000-0000-0000-0000000000a1';

type Billing = { plan: string; stripe_subscription_id: string | null; subscription_status: string | null };

/** A service-role stand-in: user_billing, the owner's workspaces, an inbox head count. */
function fakeDb(opts: { billing: Billing | null; inboxes: number; workspaceOwner?: string }) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        in: chain,
        maybeSingle: async () =>
          table === 'user_billing'
            ? { data: opts.billing, error: null }
            : { data: { owner_id: opts.workspaceOwner ?? OWNER }, error: null },
        is: async () =>
          table === 'workspaces'
            ? { data: [{ id: 'ws1' }, { id: 'ws2' }], error: null }
            : { count: opts.inboxes, error: null },
      });
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * A Stripe stand-in recording every update with its options. Stateful: an
 * update that adds an item without an id creates the add-on, so a retrieve
 * after it sees the item, unless `dropCreates` says the create was a replay.
 */
function fakeStripe(opts: {
  status?: string;
  basePrice?: string;
  addon?: { price: string; quantity: number } | null;
  /** How many creates to swallow, as a replayed stale response would. */
  dropCreates?: number;
}) {
  const updates: Array<{ id: string; params: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  let addon = opts.addon ?? null;
  let drops = opts.dropCreates ?? 0;
  const snapshot = (id: string) => ({
    id,
    status: opts.status ?? 'active',
    items: {
      data: [
        ...(addon ? [{ id: 'si_addon', price: { id: addon.price }, quantity: addon.quantity }] : []),
        { id: 'si_base', price: { id: opts.basePrice ?? 'price_business_month' }, quantity: 1 },
      ],
    },
  });
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => snapshot(id),
      update: async (id: string, params: Record<string, unknown>, options?: Record<string, unknown>) => {
        updates.push({ id, params, options });
        for (const item of (params.items ?? []) as Array<{ id?: string; price?: string; quantity?: number; deleted?: boolean }>) {
          if (item.deleted) addon = null;
          else if (!item.id && drops > 0) drops -= 1;
          else if (item.price) addon = { price: item.price, quantity: item.quantity ?? 0 };
        }
        return snapshot(id);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { stripe, updates };
}

const BUSINESS: Billing = { plan: 'pro', stripe_subscription_id: 'sub_1', subscription_status: 'active' };

test('the eleventh mailbox creates the add-on at one, billed now, with an idempotency key', async () => {
  const { stripe, updates } = fakeStripe({ addon: null });
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 11 }), stripe });
  assert.deepEqual(result, { status: 'updated', from: 0, to: 1 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.items, [{ price: 'price_addon_month', quantity: 1 }]);
  assert.equal(updates[0].params.proration_behavior, 'always_invoice');
  assert.equal(
    updates[0].options?.idempotencyKey,
    mailboxAddonCreateKey('sub_1', 'price_addon_month', 1, Date.now()),
  );
});

test('another mailbox raises the quantity and prorates it now', async () => {
  const { stripe, updates } = fakeStripe({ addon: { price: 'price_addon_month', quantity: 3 } });
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 14 }), stripe });
  assert.deepEqual(result, { status: 'updated', from: 3, to: 4 });
  assert.deepEqual(updates[0].params.items, [{ id: 'si_addon', price: 'price_addon_month', quantity: 4 }]);
  assert.equal(updates[0].params.proration_behavior, 'always_invoice');
  assert.equal(updates[0].options, undefined, 'an absolute quantity needs no key');
});

test('removing a mailbox lowers the quantity from the next renewal, with no credit', async () => {
  const { stripe, updates } = fakeStripe({ addon: { price: 'price_addon_month', quantity: 4 } });
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 12 }), stripe });
  assert.deepEqual(result, { status: 'updated', from: 4, to: 2 });
  assert.deepEqual(updates[0].params.items, [{ id: 'si_addon', price: 'price_addon_month', quantity: 2 }]);
  assert.equal(updates[0].params.proration_behavior, 'none');
});

test('back to ten keeps the item at zero rather than deleting it', async () => {
  const { stripe, updates } = fakeStripe({ addon: { price: 'price_addon_month', quantity: 1 } });
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 10 }), stripe });
  assert.deepEqual(result, { status: 'updated', from: 1, to: 0 });
  assert.deepEqual(updates[0].params.items, [{ id: 'si_addon', price: 'price_addon_month', quantity: 0 }]);
});

test('a sync with nothing changed does not call Stripe to update', async () => {
  const { stripe, updates } = fakeStripe({ addon: { price: 'price_addon_month', quantity: 2 } });
  const first = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 12 }), stripe });
  const second = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 12 }), stripe });
  assert.deepEqual(first, { status: 'unchanged', quantity: 2 });
  assert.deepEqual(second, first);
  assert.equal(updates.length, 0);

  // At or under ten with no add-on: nothing to create.
  const { stripe: s2, updates: u2 } = fakeStripe({ addon: null });
  assert.deepEqual(
    await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 7 }), stripe: s2 }),
    { status: 'unchanged', quantity: 0 },
  );
  assert.equal(u2.length, 0);
});

test('an annual Business subscription bills extras on the yearly add-on price', async () => {
  const { stripe, updates } = fakeStripe({ basePrice: 'price_business_year', addon: null });
  await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 13 }), stripe });
  assert.deepEqual(updates[0].params.items, [{ price: 'price_addon_year', quantity: 3 }]);
});

test('nothing but a live Business subscription is touched', async () => {
  const cases: Array<[Billing | null, string]> = [
    [null, 'not_business'],
    [{ plan: 'solo', stripe_subscription_id: 'sub_1', subscription_status: 'active' }, 'not_business'],
    [{ plan: 'pro', stripe_subscription_id: null, subscription_status: null }, 'no_subscription'],
  ];
  for (const [billing, reason] of cases) {
    const { stripe, updates } = fakeStripe({});
    const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing, inboxes: 40 }), stripe });
    assert.deepEqual(result, { status: 'skipped', reason });
    assert.equal(updates.length, 0);
  }

  // user_billing says Business, the live subscription is still on Pro (a change
  // in flight): the subscription wins.
  const { stripe, updates } = fakeStripe({ basePrice: 'price_solo_month' });
  assert.deepEqual(
    await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 40 }), stripe }),
    { status: 'skipped', reason: 'not_business' },
  );
  assert.equal(updates.length, 0);

  const { stripe: canceled, updates: u3 } = fakeStripe({ status: 'canceled' });
  assert.deepEqual(
    await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 40 }), stripe: canceled }),
    { status: 'skipped', reason: 'not_entitled' },
  );
  assert.equal(u3.length, 0);
});

test('a Stripe failure is returned, never thrown', async () => {
  const { stripe } = fakeStripe({ addon: null });
  stripe.subscriptions.update = async () => {
    throw new Error('stripe_down');
  };
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 15 }), stripe });
  assert.deepEqual(result, { status: 'failed', reason: 'stripe_down' });
});

test('a workspace sync resolves the subscription OWNER, not the acting member', async () => {
  const { stripe, updates } = fakeStripe({ addon: null });
  const result = await syncMailboxAddonForWorkspace('ws1', {
    db: fakeDb({ billing: BUSINESS, inboxes: 11, workspaceOwner: OWNER }),
    stripe,
  });
  assert.equal(result.status, 'updated');
  assert.equal(updates.length, 1);
});

test('the pure item plan: delete when leaving Business, refuse an unconfigured price', () => {
  assert.deepEqual(
    mailboxAddonItemChanges({
      targetPlan: 'solo',
      interval: 'month',
      extra: 0,
      addonItem: { id: 'si_addon', priceId: 'price_addon_month', quantity: 3 },
    }),
    [{ id: 'si_addon', deleted: true }],
  );
  assert.deepEqual(
    mailboxAddonItemChanges({ targetPlan: 'personal', interval: 'month', extra: 0, addonItem: null }),
    [],
  );
  const saved = process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY;
  delete process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY;
  try {
    assert.throws(
      () => mailboxAddonItemChanges({ targetPlan: 'pro', interval: 'year', extra: 0, addonItem: null }),
      /addon_price_not_configured/,
    );
  } finally {
    process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = saved;
  }
});

test('the create key dedupes one intent but changes for a later creation', () => {
  const t = Date.UTC(2026, 9, 20, 12, 0, 0);
  const key = mailboxAddonCreateKey('sub_1', 'price_addon_month', 1, t);
  assert.equal(mailboxAddonCreateKey('sub_1', 'price_addon_month', 1, t + 30_000), key, 'a retry seconds later dedupes');
  assert.notEqual(mailboxAddonCreateKey('sub_1', 'price_addon_month', 1, t + 3_600_000), key, 'an hour later is a new create');
  assert.notEqual(mailboxAddonCreateKey('sub_1', 'price_addon_month', 2, t), key, 'a different quantity is a different intent');
  assert.notEqual(mailboxAddonCreateKey('sub_1', 'price_addon_year', 1, t), key);
});

test('created, removed, then needed again within a day: the add-on is recreated', async () => {
  const realNow = Date.now;
  try {
    const t = Date.UTC(2026, 9, 20, 12, 0, 0);
    Date.now = () => t;
    const { stripe, updates } = fakeStripe({ addon: null });
    const db = fakeDb({ billing: BUSINESS, inboxes: 11 });
    assert.equal((await syncMailboxAddon(OWNER, { db, stripe })).status, 'updated');
    // The add-on goes away (a plan change off Business and back).
    await stripe.subscriptions.update('sub_1', { items: [{ id: 'si_addon', deleted: true }] });
    Date.now = () => t + 2 * 3_600_000;
    assert.deepEqual(await syncMailboxAddon(OWNER, { db, stripe }), { status: 'updated', from: 0, to: 1 });
    const creates = updates.filter((u) => u.options?.idempotencyKey);
    assert.equal(creates.length, 2);
    assert.notEqual(creates[0].options?.idempotencyKey, creates[1].options?.idempotencyKey);
    const live = await stripe.subscriptions.retrieve('sub_1');
    assert.equal(live.items.data.some((i: { price: { id: string } }) => i.price.id === 'price_addon_month'), true);
  } finally {
    Date.now = realNow;
  }
});

test('a create that leaves no item on the live subscription is retried once with a fresh key', async () => {
  const { stripe, updates } = fakeStripe({ addon: null, dropCreates: 1 });
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 12 }), stripe });
  assert.deepEqual(result, { status: 'updated', from: 0, to: 2 });
  assert.equal(updates.length, 2);
  assert.notEqual(updates[0].options?.idempotencyKey, updates[1].options?.idempotencyKey);
  assert.match(String(updates[1].options?.idempotencyKey), /:retry:/);
});

test('a create that still leaves no item is reported as failed, not updated', async () => {
  const { stripe } = fakeStripe({ addon: null, dropCreates: 2 });
  const result = await syncMailboxAddon(OWNER, { db: fakeDb({ billing: BUSINESS, inboxes: 12 }), stripe });
  assert.deepEqual(result, { status: 'failed', reason: 'addon_item_missing_after_create' });
});

test('an add-on on an inclusive twin keeps the twin; only the quantity moves', () => {
  process.env.STRIPE_PRICE_TWINS = JSON.stringify({
    price_twin_addon_month: 'price_addon_month',
    price_twin_addon_year: 'price_addon_year',
  });
  try {
    const onTwin = { id: 'si_addon', priceId: 'price_twin_addon_month', quantity: 2 };
    assert.deepEqual(
      mailboxAddonItemChanges({ targetPlan: 'pro', interval: 'month', extra: 2, addonItem: onTwin }),
      [],
    );
    assert.deepEqual(
      mailboxAddonItemChanges({ targetPlan: 'pro', interval: 'month', extra: 3, addonItem: onTwin }),
      [{ id: 'si_addon', quantity: 3 }],
    );
    // An interval switch from a twin lands on the other interval's twin.
    assert.deepEqual(
      mailboxAddonItemChanges({ targetPlan: 'pro', interval: 'year', extra: 3, addonItem: onTwin }),
      [{ id: 'si_addon', price: 'price_twin_addon_year', quantity: 3 }],
    );
    // Not on a twin: unchanged, the plain price.
    assert.deepEqual(
      mailboxAddonItemChanges({
        targetPlan: 'pro', interval: 'year', extra: 1,
        addonItem: { id: 'si_addon', priceId: 'price_addon_month', quantity: 1 },
      }),
      [{ id: 'si_addon', price: 'price_addon_year', quantity: 1 }],
    );
  } finally {
    delete process.env.STRIPE_PRICE_TWINS;
  }
});
