// ---------------------------------------------------------------------------
// Business billed per person: who is billable, and the seat quantity sync.
//
// The properties that cost a customer money if they break:
//   1. Viewers never count; an admin or member counts only once they own a
//      mailbox in one of the owner's workspaces; one person counts once.
//   2. The quantity never drops below 2.
//   3. Adding a person bills now (always_invoice); removing one credits the
//      unused rest (create_prorations); nothing changed calls no update.
//   4. Switch off, or a base price that is not a seat price (flat $39,
//      founder, Team): nothing is written, ever.
//   5. A count that moves while Stripe is being written is caught by a
//      second pass, so the last word is the live count.
//   6. On a per-person subscription the mailbox add-on counts company-wide
//      mailboxes only, and the workspace-level sync re-syncs seats too.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/business-seats.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY = 'price_founder_month';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_YEARLY = 'price_founder_year';
process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY = 'price_seat_month';
process.env.STRIPE_PRICE_BUSINESS_SEAT_YEARLY = 'price_seat_year';

const {
  billablePeopleFrom,
  businessSeatPricingOn,
  resetBusinessSeatSwitchCache,
  seatProrationBehavior,
  syncBusinessSeats,
} = await import('./business-seats.ts');
const { syncMailboxAddon, syncMailboxAddonForWorkspace } = await import('./mailbox-addon.ts');
const { businessSeatQuantity, getPlanByStripePriceId, isBusinessSeatPriceId } = await import('./plans.ts');

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const WS1 = 'ws1';
const WS2 = 'ws2';

type Member = { workspace_id: string; user_id: string; role: string };
type InboxOwner = { workspace_id: string; owner_user_id: string | null };

interface World {
  switchOn?: boolean | 'error';
  billing?: { plan: string; stripe_subscription_id: string | null } | null;
  members?: Member[];
  inboxOwners?: InboxOwner[];
  allInboxes?: number;
  companyInboxes?: number;
  /** Called on every member read: lets a test move the count mid-sync. */
  onMemberRead?: (read: number) => Member[] | undefined;
}

function fakeDb(world: World) {
  const tablesRead: string[] = [];
  let memberReads = 0;
  const db = {
    from(table: string) {
      tablesRead.push(table);
      let visibility: unknown = null;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        in: chain,
        is: chain,
        not: chain,
        order: chain,
        eq: (col: string, value: unknown) => {
          if (col === 'visibility') visibility = value;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'pricing_switches') {
            if (world.switchOn === 'error') return { data: null, error: { message: 'boom' } };
            return { data: { enabled: world.switchOn ?? true }, error: null };
          }
          if (table === 'user_billing') {
            return {
              data: world.billing === undefined
                ? { plan: 'pro', stripe_subscription_id: 'sub_1', subscription_status: 'active' }
                : world.billing,
              error: null,
            };
          }
          if (table === 'workspaces') return { data: { owner_id: OWNER }, error: null };
          return { data: null, error: null };
        },
        range: async () => {
          if (table === 'workspace_members') {
            memberReads += 1;
            const moved = world.onMemberRead?.(memberReads);
            return { data: moved ?? world.members ?? [], error: null };
          }
          return { data: world.inboxOwners ?? [], error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(
            table === 'workspaces'
              ? { data: [{ id: WS1 }, { id: WS2 }], error: null }
              : { count: visibility === 'company' ? (world.companyInboxes ?? 0) : (world.allInboxes ?? 0), error: null },
          ).then(resolve, reject),
      });
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, tablesRead };
}

/** A Stripe stand-in whose base item quantity follows the updates it receives. */
function fakeStripe(opts: {
  price?: string;
  quantity?: number;
  status?: string;
  pendingUpdate?: boolean;
  paused?: boolean;
  addon?: { price: string; quantity: number } | null;
}) {
  const updates: Array<Record<string, unknown>> = [];
  let quantity = opts.quantity ?? 2;
  let addon = opts.addon ?? null;
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        status: opts.status ?? 'active',
        pending_update: opts.pendingUpdate ? { expires_at: 1 } : null,
        pause_collection: opts.paused ? { behavior: 'void' } : null,
        items: {
          data: [
            { id: 'si_base', price: { id: opts.price ?? 'price_seat_month' }, quantity },
            ...(addon ? [{ id: 'si_addon', price: { id: addon.price }, quantity: addon.quantity }] : []),
          ],
        },
      }),
      update: async (id: string, params: { items: Array<Record<string, unknown>> }) => {
        updates.push({ id, ...params });
        for (const item of params.items) {
          if (item.id === 'si_base' && typeof item.quantity === 'number') quantity = item.quantity;
          if (item.id === 'si_addon' && typeof item.quantity === 'number' && addon) addon = { ...addon, quantity: item.quantity };
          if (!item.id && typeof item.price === 'string') addon = { price: item.price, quantity: Number(item.quantity) };
        }
        return {};
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { stripe: stripe as any, updates };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

const m = (workspace_id: string, user_id: string, role: string): Member => ({ workspace_id, user_id, role });
const i = (workspace_id: string, owner_user_id: string | null): InboxOwner => ({ workspace_id, owner_user_id });

// ── Pure ────────────────────────────────────────────────────────────────────

test('billable people: owner always, members and admins with a mailbox, never viewers', () => {
  assert.equal(billablePeopleFrom({ ownerId: OWNER, members: [], inboxes: [] }), 1);
  assert.equal(
    billablePeopleFrom({
      ownerId: OWNER,
      members: [
        m(WS1, OWNER, 'owner'),
        m(WS1, 'member-with', 'member'),
        m(WS1, 'member-without', 'member'),
        m(WS1, 'admin-with', 'admin'),
        m(WS1, 'admin-without', 'admin'),
        m(WS1, 'viewer-with', 'viewer'),
      ],
      inboxes: [
        i(WS1, OWNER),
        i(WS1, 'member-with'),
        i(WS1, 'member-with'),
        i(WS1, 'admin-with'),
        i(WS1, 'viewer-with'),
        i(WS1, null),
      ],
    }),
    3,
  );
});

test('billable people: one person in two workspaces counts once; a mailbox elsewhere does not count', () => {
  assert.equal(
    billablePeopleFrom({
      ownerId: OWNER,
      members: [m(WS1, 'p', 'member'), m(WS2, 'p', 'admin'), m(WS2, 'q', 'member')],
      inboxes: [i(WS1, 'p'), i(WS2, 'p'), i(WS1, 'q')],
    }),
    2,
    'p counts once; q owns a mailbox only in WS1, where q is not a member',
  );
});

test('the quantity never drops below two', () => {
  assert.equal(businessSeatQuantity(0), 2);
  assert.equal(businessSeatQuantity(1), 2);
  assert.equal(businessSeatQuantity(2), 2);
  assert.equal(businessSeatQuantity(7), 7);
  assert.equal(businessSeatQuantity(Number.NaN), 2);
});

test('proration: up invoices now, down credits, same sends nothing', () => {
  assert.equal(seatProrationBehavior(2, 3), 'always_invoice');
  assert.equal(seatProrationBehavior(4, 2), 'create_prorations');
  assert.equal(seatProrationBehavior(3, 3), null);
});

test('seat prices resolve to Business; flat and founder prices are not seat prices', () => {
  assert.equal(getPlanByStripePriceId('price_seat_month')?.plan.id, 'pro');
  assert.equal(getPlanByStripePriceId('price_seat_year')?.interval, 'year');
  assert.equal(isBusinessSeatPriceId('price_seat_year'), true);
  assert.equal(isBusinessSeatPriceId('price_business_month'), false);
  assert.equal(isBusinessSeatPriceId('price_founder_month'), false);
  assert.equal(isBusinessSeatPriceId(null), false);
});

// ── The switch ──────────────────────────────────────────────────────────────

test('the switch fails closed and is cached for a minute', async () => {
  resetBusinessSeatSwitchCache();
  assert.equal(await quiet(() => businessSeatPricingOn({ db: fakeDb({ switchOn: 'error' }).db, now: 0 })), false);
  resetBusinessSeatSwitchCache();
  const on = fakeDb({ switchOn: true });
  assert.equal(await businessSeatPricingOn({ db: on.db, now: 1_000 }), true);
  assert.equal(await businessSeatPricingOn({ db: fakeDb({ switchOn: false }).db, now: 30_000 }), true, 'cached');
  assert.equal(await businessSeatPricingOn({ db: fakeDb({ switchOn: false }).db, now: 30_000, fresh: true }), false);
  resetBusinessSeatSwitchCache();
});

// ── Sync ────────────────────────────────────────────────────────────────────

test('switch off: nothing is read past the switch and nothing is written', async () => {
  const { db, tablesRead } = fakeDb({ switchOn: false });
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  assert.deepEqual(await syncBusinessSeats(OWNER, { db, stripe, switchOn: false }), {
    status: 'skipped',
    reason: 'switch_off',
  });
  assert.deepEqual(tablesRead, []);
  assert.equal(updates.length, 0);
});

test('legacy flat, founder and Team prices are never touched', async () => {
  for (const price of ['price_business_month', 'price_founder_year', 'price_pro_legacy']) {
    const { db } = fakeDb({ members: [m(WS1, 'p', 'member')], inboxOwners: [i(WS1, 'p')] });
    const { stripe, updates } = fakeStripe({ price, quantity: 1 });
    const result = await syncBusinessSeats(OWNER, { db, stripe, switchOn: true });
    assert.deepEqual(result, { status: 'skipped', reason: 'not_seat_price' }, price);
    assert.equal(updates.length, 0, price);
  }
});

test('not Business, no subscription, not entitled, pending update or paused: skipped, nothing written', async () => {
  const cases: Array<[World, Parameters<typeof fakeStripe>[0], string]> = [
    [{ billing: { plan: 'solo', stripe_subscription_id: 'sub_1' } }, {}, 'not_business'],
    [{ billing: null }, {}, 'not_business'],
    [{ billing: { plan: 'pro', stripe_subscription_id: null } }, {}, 'no_subscription'],
    [{}, { status: 'canceled' }, 'not_entitled'],
    [{}, { pendingUpdate: true }, 'pending_update'],
    [{}, { paused: true }, 'paused'],
  ];
  for (const [world, stripeOpts, reason] of cases) {
    const { db } = fakeDb(world);
    const { stripe, updates } = fakeStripe(stripeOpts);
    assert.deepEqual(await syncBusinessSeats(OWNER, { db, stripe, switchOn: true }), { status: 'skipped', reason });
    assert.equal(updates.length, 0, reason);
  }
});

test('nothing changed: no update call at all', async () => {
  const { db } = fakeDb({ members: [m(WS1, 'p', 'member')], inboxOwners: [i(WS1, 'p')] });
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  assert.deepEqual(await syncBusinessSeats(OWNER, { db, stripe, switchOn: true }), { status: 'unchanged', quantity: 2 });
  assert.equal(updates.length, 0);
});

test('a third person with a mailbox: quantity 3, invoiced now', async () => {
  const { db } = fakeDb({
    members: [m(WS1, 'p', 'member'), m(WS2, 'q', 'admin'), m(WS1, 'v', 'viewer')],
    inboxOwners: [i(WS1, 'p'), i(WS2, 'q'), i(WS1, 'v')],
  });
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  const result = await quiet(() => syncBusinessSeats(OWNER, { db, stripe, switchOn: true }));
  assert.deepEqual(result, { status: 'updated', from: 2, to: 3 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].items, [{ id: 'si_base', quantity: 3 }]);
  assert.equal(updates[0].proration_behavior, 'always_invoice');
});

test('people leave: quantity falls to the live count, credited, never below two', async () => {
  const { db } = fakeDb({ members: [], inboxOwners: [] });
  const { stripe, updates } = fakeStripe({ quantity: 5 });
  const result = await quiet(() => syncBusinessSeats(OWNER, { db, stripe, switchOn: true }));
  assert.deepEqual(result, { status: 'updated', from: 5, to: 2 });
  assert.deepEqual(updates[0].items, [{ id: 'si_base', quantity: 2 }]);
  assert.equal(updates[0].proration_behavior, 'create_prorations');
});

test('running twice converges: the second run writes nothing', async () => {
  const world: World = { members: [m(WS1, 'p', 'member'), m(WS1, 'q', 'member')], inboxOwners: [i(WS1, 'p'), i(WS1, 'q')] };
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  await quiet(() => syncBusinessSeats(OWNER, { db: fakeDb(world).db, stripe, switchOn: true }));
  const again = await syncBusinessSeats(OWNER, { db: fakeDb(world).db, stripe, switchOn: true });
  assert.deepEqual(again, { status: 'unchanged', quantity: 3 });
  assert.equal(updates.length, 1);
});

test('a count that moves during the write is caught by a second pass', async () => {
  const later = [m(WS1, 'p', 'member'), m(WS1, 'q', 'member'), m(WS1, 'r', 'member')];
  const { db } = fakeDb({
    members: [m(WS1, 'p', 'member')],
    inboxOwners: [i(WS1, 'p'), i(WS1, 'q'), i(WS1, 'r')],
    onMemberRead: (read) => (read >= 2 ? later : undefined),
  });
  const { stripe, updates } = fakeStripe({ quantity: 4 });
  const result = await quiet(() => syncBusinessSeats(OWNER, { db, stripe, switchOn: true }));
  assert.deepEqual(result, { status: 'updated', from: 4, to: 4 });
  assert.deepEqual(updates.map((u) => (u.items as Array<{ quantity: number }>)[0].quantity), [2, 4]);
  assert.deepEqual(updates.map((u) => u.proration_behavior), ['create_prorations', 'always_invoice']);
});

test('a Stripe failure is returned, never thrown', async () => {
  const { db } = fakeDb({ members: [m(WS1, 'p', 'member'), m(WS1, 'q', 'member')], inboxOwners: [i(WS1, 'p'), i(WS1, 'q')] });
  const { stripe } = fakeStripe({ quantity: 2 });
  stripe.subscriptions.update = async () => {
    throw new Error('card_declined');
  };
  const result = await quiet(() => syncBusinessSeats(OWNER, { db, stripe, switchOn: true }));
  assert.deepEqual(result, { status: 'failed', reason: 'card_declined' });
});

// ── With the mailbox add-on ────────────────────────────────────────────────

test('add-on on a per-person subscription counts company-wide mailboxes only', async () => {
  const { db } = fakeDb({ allInboxes: 40, companyInboxes: 13 });
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  const result = await quiet(() => syncMailboxAddon(OWNER, { db, stripe }));
  assert.deepEqual(result, { status: 'updated', from: 0, to: 3 });
  assert.deepEqual(updates[0].items, [{ price: 'price_addon_month', quantity: 3 }]);
});

test('add-on on a flat Business subscription still counts every mailbox', async () => {
  const { db } = fakeDb({ allInboxes: 12, companyInboxes: 0 });
  const { stripe, updates } = fakeStripe({ price: 'price_business_month', quantity: 1 });
  const result = await quiet(() => syncMailboxAddon(OWNER, { db, stripe }));
  assert.deepEqual(result, { status: 'updated', from: 0, to: 2 });
  assert.deepEqual(updates[0].items, [{ price: 'price_addon_month', quantity: 2 }]);
});

test('the workspace-level sync every connect and delete route calls re-syncs seats too', async () => {
  resetBusinessSeatSwitchCache();
  const { db } = fakeDb({
    switchOn: true,
    members: [m(WS1, 'p', 'member'), m(WS1, 'q', 'member')],
    inboxOwners: [i(WS1, 'p'), i(WS1, 'q')],
  });
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  await quiet(() => syncMailboxAddonForWorkspace(WS1, { db, stripe }));
  assert.deepEqual(updates.map((u) => u.items), [[{ id: 'si_base', quantity: 3 }]]);
  resetBusinessSeatSwitchCache();
});

test('the workspace-level sync with the switch off writes no seat change', async () => {
  resetBusinessSeatSwitchCache();
  const { db } = fakeDb({
    switchOn: false,
    members: [m(WS1, 'p', 'member'), m(WS1, 'q', 'member')],
    inboxOwners: [i(WS1, 'p'), i(WS1, 'q')],
  });
  const { stripe, updates } = fakeStripe({ quantity: 2 });
  await quiet(() => syncMailboxAddonForWorkspace(WS1, { db, stripe }));
  assert.equal(updates.length, 0);
  resetBusinessSeatSwitchCache();
});

// ── The price map the dashboard renders ────────────────────────────────────

test('the dashboard price map: per person while on, untouched while off', async () => {
  process.env.STRIPE_SECRET_KEY ??= 'sk_test_business_seats_unit';
  const { withBusinessSeatPrices } = await import('./business-seat-display.ts');
  const prices = {
    pro: {
      monthlyCents: 3900,
      yearlyCents: 37440,
      monthlyPriceConfigured: true,
      yearlyPriceConfigured: true,
      founder: { monthlyCents: 2900, yearlyCents: 27840, addonMonthlyCents: 300, placesLeft: 3, placesTotal: 20 },
    },
    solo: { monthlyCents: 1500, yearlyCents: 14400, monthlyPriceConfigured: true, yearlyPriceConfigured: true },
  };
  assert.equal(await withBusinessSeatPrices(prices, { seatOn: false }), prices);
  const on = await withBusinessSeatPrices(prices, {
    seatOn: true,
    amounts: { monthlyCents: 1900, yearlyCents: 18240 },
  });
  assert.equal(on.pro.monthlyCents, 1900);
  assert.equal(on.pro.yearlyCents, 18240);
  assert.equal(on.pro.eurMonthlyCents, 1900);
  assert.deepEqual(on.pro.perPerson, { minPeople: 2 });
  assert.equal('founder' in on.pro, false, 'no founder line while per person is on');
  assert.equal(on.solo, prices.solo);
});
