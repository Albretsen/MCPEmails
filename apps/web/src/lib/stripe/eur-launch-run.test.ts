// ---------------------------------------------------------------------------
// The EUR launch dispatcher run (eur-launch-run.ts) against a fake Stripe and
// an in-memory pricing_switches store. Nothing here talks to Stripe or a
// database.
//
// What must hold: nothing happens before the date; any failed preflight check
// writes nothing and alerts once a day; a passing preflight adds the EUR
// options, then sets the flag, then alerts; a second run changes nothing; the
// legacy swap pages under its cap and never touches the flag.
//
// Run: node --test --experimental-strip-types src/lib/stripe/eur-launch-run.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

// plans.ts reads its ids at import, so the env comes first.
const IDS: Record<string, string> = {
  STRIPE_PRICE_PERSONAL_MONTHLY_V2: 'price_pm2',
  STRIPE_PRICE_PERSONAL_YEARLY_V2: 'price_py2',
  STRIPE_PRICE_SOLO_MONTHLY: 'price_sm',
  STRIPE_PRICE_SOLO_YEARLY: 'price_sy',
  STRIPE_PRICE_SOLO_MONTHLY_V2: 'price_sm2',
  STRIPE_PRICE_SOLO_YEARLY_V2: 'price_sy2',
  STRIPE_PRICE_BUSINESS_MONTHLY: 'price_bm',
  STRIPE_PRICE_BUSINESS_YEARLY: 'price_by',
  STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY: 'price_mm',
  STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY: 'price_my',
};
for (const [k, v] of Object.entries(IDS)) process.env[k] = v;
delete process.env.STRIPE_PRICE_TWINS;

const run = await import('./eur-launch-run.ts');
const { runEurLaunchDispatch, osloDay, alertKey, proV2RequiredAtLaunch, EUR_LAUNCH_FLAG, EUR_SWAP_DONE_FLAG } = run;
type LaunchAlert = import('./eur-launch-run.ts').LaunchAlert;

const BEFORE = Date.parse('2026-12-06T22:59:59.000Z');
const LAUNCH_DAY = Date.parse('2026-12-07T06:00:00.000Z');
const NEXT_DAY = Date.parse('2026-12-08T06:00:00.000Z');

const AMOUNTS: Record<string, [number, 'month' | 'year']> = {
  price_pm2: [900, 'month'],
  price_py2: [8640, 'year'],
  price_sm: [1500, 'month'],
  price_sy: [14400, 'year'],
  price_sm2: [1900, 'month'],
  price_sy2: [18240, 'year'],
  price_bm: [3900, 'month'],
  price_by: [37440, 'year'],
  price_mm: [300, 'month'],
  price_my: [2880, 'year'],
};

type Obj = Record<string, unknown> & { id: string };
interface FakeState {
  registrations: Obj[];
  webhooks: Obj[];
  pmcs: Obj[];
  prices: Record<string, Obj>;
  products: Record<string, Obj>;
  subs: Obj[];
  charges: Record<string, Obj[]>;
  failPricePost?: boolean;
  failSubPost?: boolean;
}

function goodState(): FakeState {
  const prices: Record<string, Obj> = {};
  for (const [id, [amount, interval]] of Object.entries(AMOUNTS)) {
    prices[id] = {
      object: 'price',
      id,
      active: true,
      currency: 'usd',
      unit_amount: amount,
      tax_behavior: id === 'price_sm' ? 'unspecified' : 'exclusive',
      product: id.startsWith('price_m') ? 'prod_mailbox' : 'prod_main',
      recurring: { interval, interval_count: 1, usage_type: 'licensed' },
      metadata: {},
      currency_options: { usd: { unit_amount: amount, tax_behavior: 'exclusive' } },
    };
  }
  // One price already carries its EUR option (Pro V2 is created with it).
  (prices.price_sm2.currency_options as Record<string, unknown>).eur = { unit_amount: 1900, tax_behavior: 'inclusive' };
  return {
    registrations: [
      { id: 'taxreg_1', status: 'active', country: 'IE', country_options: { ie: { type: 'oss_non_union' } } },
      { id: 'taxreg_2', status: 'active', country: 'NO', country_options: { no: { type: 'standard' } } },
    ],
    webhooks: [
      { id: 'we_other', status: 'enabled', enabled_events: ['customer.subscription.updated'] },
      { id: 'we_ingress', status: 'enabled', enabled_events: ['checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'charge.dispute.created', 'invoice.paid'] },
    ],
    pmcs: [{ id: 'pmc_default', active: true, is_default: true, parent: null, sepa_debit: { available: true } }],
    prices,
    products: { prod_main: { id: 'prod_main', tax_code: null }, prod_mailbox: { id: 'prod_mailbox', tax_code: 'txcd_10000000' } },
    subs: [],
    charges: {},
  };
}

function notFound(path: string): Error {
  return new Error(`GET ${path}: No such resource`);
}

function fakeStripe(state: FakeState) {
  const calls: Array<{ method: string; path: string; params: Record<string, unknown> }> = [];
  let twinSeq = 0;
  const list = (data: Obj[]) => ({ data, has_more: false });
  const transport = {
    transport: 'fake',
    async request(method: string, path: string, params: Record<string, unknown> = {}): Promise<never> {
      calls.push({ method, path, params });
      const r = (v: unknown) => v as never;
      if (method === 'GET' && path === '/v1/tax/registrations') return r(list(state.registrations));
      if (method === 'GET' && path === '/v1/webhook_endpoints') return r(list(state.webhooks));
      if (method === 'GET' && path === '/v1/payment_method_configurations') return r(list(state.pmcs));
      if (method === 'GET' && path.startsWith('/v1/payment_method_configurations/')) {
        const found = state.pmcs.find((p) => p.id === path.split('/').pop());
        if (!found) throw notFound(path);
        return r(found);
      }
      if (method === 'GET' && path === '/v1/prices') {
        return r(list(Object.values(state.prices).filter((p) => p.product === params.product && p.active === true)));
      }
      if (method === 'POST' && path === '/v1/prices') {
        twinSeq += 1;
        const id = `price_twin${twinSeq}`;
        state.prices[id] = {
          object: 'price',
          id,
          active: true,
          currency: params.currency,
          unit_amount: Number(params.unit_amount),
          tax_behavior: params.tax_behavior,
          product: params.product,
          recurring: { interval: params['recurring[interval]'], interval_count: Number(params['recurring[interval_count]']) },
          metadata: { twin_of: params['metadata[twin_of]'] as string },
        };
        return r(state.prices[id]);
      }
      if (path.startsWith('/v1/prices/')) {
        const id = path.split('/').pop() as string;
        const price = state.prices[id];
        if (!price) throw notFound(path);
        if (method === 'GET') return r(structuredClone(price));
        if (state.failPricePost) throw new Error(`POST ${path}: boom`);
        if (params.tax_behavior) price.tax_behavior = params.tax_behavior;
        if (params['currency_options[eur][unit_amount]']) {
          const opts = (price.currency_options ?? {}) as Record<string, unknown>;
          if (opts.eur) throw new Error('immutable');
          opts.eur = { unit_amount: Number(params['currency_options[eur][unit_amount]']), tax_behavior: params['currency_options[eur][tax_behavior]'] };
          price.currency_options = opts;
        }
        return r(price);
      }
      if (path.startsWith('/v1/products/')) {
        const product = state.products[path.split('/').pop() as string];
        if (!product) throw notFound(path);
        if (method === 'POST') product.tax_code = params.tax_code;
        return r(product);
      }
      if (method === 'GET' && path === '/v1/subscriptions') {
        return r(list(state.subs.filter((s) => s.status === params.status)));
      }
      if (method === 'GET' && path === '/v1/charges') return r(list(state.charges[params.customer as string] ?? []));
      if (method === 'POST' && path.startsWith('/v1/subscriptions/')) {
        if (state.failSubPost) throw new Error(`POST ${path}: card_declined for cus_secret`);
        const sub = state.subs.find((s) => s.id === path.split('/').pop());
        if (!sub) throw notFound(path);
        const items = (sub.items as { data: Array<{ id: string; price: Obj }> }).data;
        for (let i = 0; params[`items[${i}][id]`]; i++) {
          const item = items.find((it) => it.id === params[`items[${i}][id]`]);
          if (item) item.price = structuredClone(state.prices[params[`items[${i}][price]`] as string]);
        }
        sub.automatic_tax = { enabled: params['automatic_tax[enabled]'] === 'true' };
        return r(sub);
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const writes = () => calls.filter((c) => c.method === 'POST');
  return { transport, calls, writes };
}

function memoryStore(initial: Record<string, boolean> = {}) {
  const rows = new Map<string, { enabled: boolean; note: string }>();
  for (const [k, v] of Object.entries(initial)) rows.set(k, { enabled: v, note: '' });
  return {
    rows,
    async readFlag(key: string): Promise<boolean | null> {
      return rows.get(key)?.enabled === true;
    },
    async writeFlag(key: string, enabled: boolean, note: string) {
      rows.set(key, { enabled, note });
    },
    async claimAlert(day: string, reason: string, note: string) {
      const key = alertKey(day, reason);
      if (rows.has(key)) return false;
      rows.set(key, { enabled: true, note });
      return true;
    },
  };
}

function harness(state: FakeState = goodState(), store = memoryStore(), env: Record<string, string | undefined> = { ...IDS }) {
  const stripe = fakeStripe(state);
  const alerts: LaunchAlert[] = [];
  const go = (now: number, extra: Record<string, unknown> = {}) =>
    runEurLaunchDispatch({
      stripe: stripe.transport,
      store,
      notify: async (a) => {
        alerts.push(a);
      },
      env,
      now,
      ...extra,
    });
  return { state, store, stripe, alerts, go };
}

test('before 2026-12-07 Oslo: outside_window, and not one call to Stripe or the store', async () => {
  const h = harness();
  let reads = 0;
  h.store.readFlag = async () => {
    reads++;
    return false;
  };
  const report = await h.go(BEFORE);
  assert.equal(report.mode, 'outside_window');
  assert.equal(h.stripe.calls.length, 0);
  assert.equal(reads, 0);
  assert.equal(h.alerts.length, 0);
});

test('the Oslo day an alert is deduplicated on', () => {
  assert.equal(osloDay(Date.parse('2026-12-06T23:00:00.000Z')), '2026-12-07');
  assert.equal(osloDay(Date.parse('2026-12-07T22:59:00.000Z')), '2026-12-07');
  assert.equal(osloDay(Date.parse('2026-12-07T23:00:00.000Z')), '2026-12-08');
});

const failures: Array<[string, (s: FakeState, env: Record<string, string | undefined>) => void]> = [
  ['tax_registrations', (s) => { s.registrations = s.registrations.filter((r) => r.country !== 'IE'); }],
  ['tax_registrations', (s) => { s.registrations = s.registrations.filter((r) => r.country !== 'NO'); }],
  ['webhook_events', (s) => { s.webhooks[1].enabled_events = ['checkout.session.async_payment_succeeded']; }],
  ['webhook_events', (s) => { s.webhooks[1].status = 'disabled'; }],
  ['payment_methods', (s) => { s.pmcs[0].sepa_debit = { available: false }; }],
  ['payment_methods', (_s, env) => { env.STRIPE_PMC_ID = 'pmc_missing'; }],
  ['prices', (_s, env) => { delete env.STRIPE_PRICE_SOLO_MONTHLY_V2; }],
  ['prices', (s) => { s.prices.price_bm.unit_amount = 4900; }],
  ['prices', (s) => { (s.prices.price_pm2.currency_options as Record<string, unknown>).eur = { unit_amount: 1000, tax_behavior: 'inclusive' }; }],
  ['prices', (s) => { s.prices.price_by.tax_behavior = 'inclusive'; }],
  ['prices', (s) => { delete s.prices.price_my; }],
];

for (const [code, breakIt] of failures) {
  test(`preflight fails on ${code}: nothing written, one alert naming it`, async () => {
    const state = goodState();
    const env: Record<string, string | undefined> = { ...IDS };
    breakIt(state, env);
    const h = harness(state, memoryStore(), env);
    const report = await h.go(LAUNCH_DAY);
    assert.equal(report.mode, 'preflight_failed');
    assert.deepEqual(report.failed, [code]);
    assert.equal(h.stripe.writes().length, 0, 'no Stripe write');
    assert.equal(h.store.rows.get(EUR_LAUNCH_FLAG)?.enabled ?? false, false, 'flag untouched');
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].kind, 'preflight_failed');
    assert.ok(h.alerts[0].lines.some((l) => l.startsWith(`FAILED ${code}:`)), 'alert names the check');
    assert.ok(h.alerts[0].lines.some((l) => l.includes('What to do:')), 'alert says what to do');
  });
}

test('every failing check is listed at once, not only the first', async () => {
  const state = goodState();
  state.registrations = [];
  state.webhooks = [];
  const h = harness(state);
  const report = await h.go(LAUNCH_DAY);
  assert.deepEqual(report.failed, ['tax_registrations', 'webhook_events']);
});

test('alert dedupe: hourly retries on one Oslo day send one email; the next day sends again', async () => {
  const state = goodState();
  state.registrations = [];
  const h = harness(state);
  for (let hour = 0; hour < 5; hour++) {
    const report = await h.go(LAUNCH_DAY + hour * 3_600_000);
    assert.equal(report.mode, 'preflight_failed');
  }
  assert.equal(h.alerts.length, 1);
  await h.go(NEXT_DAY);
  assert.equal(h.alerts.length, 2);
});

test('Pro V2 prices are required at launch while the Pro change is on, not once it is called off', () => {
  assert.equal(proV2RequiredAtLaunch({ priceLive: false, announce: true }), true);
  assert.equal(proV2RequiredAtLaunch({ priceLive: true, announce: false }), true);
  assert.equal(proV2RequiredAtLaunch({ priceLive: false, announce: false }), false);
});

test('launch: EUR options and tax codes first, then the flag, then one "live" alert', async () => {
  const h = harness();
  let callsAtFlagWrite = -1;
  const write = h.store.writeFlag;
  h.store.writeFlag = async (key, enabled, note) => {
    if (key === EUR_LAUNCH_FLAG) callsAtFlagWrite = h.stripe.calls.length;
    return write(key, enabled, note);
  };
  const report = await h.go(LAUNCH_DAY);
  assert.equal(report.mode, 'launched');
  // Nine sold prices lack EUR (Pro V2 monthly had it), one needed exclusive too.
  assert.equal(report.changes?.pricesUpdated, 9);
  assert.equal(report.changes?.productsTagged, 1);
  for (const id of Object.keys(AMOUNTS)) {
    const eur = (h.state.prices[id].currency_options as Record<string, { unit_amount: number; tax_behavior: string }>).eur;
    assert.deepEqual(eur, { unit_amount: AMOUNTS[id][0], tax_behavior: 'inclusive' }, id);
  }
  assert.equal(h.state.prices.price_sm.tax_behavior, 'exclusive');
  assert.equal(h.state.products.prod_main.tax_code, 'txcd_10000000');
  assert.equal(h.store.rows.get(EUR_LAUNCH_FLAG)?.enabled, true);
  assert.deepEqual(h.alerts.map((a) => a.kind), ['live']);
  // The flag write comes after the last catalogue write.
  const lastCatalogueWrite = h.stripe.calls.findLastIndex(
    (c) => c.method === 'POST' && (c.path.startsWith('/v1/prices/') || c.path.startsWith('/v1/products/')),
  );
  assert.ok(lastCatalogueWrite >= 0);
  assert.ok(callsAtFlagWrite > lastCatalogueWrite, 'flag written after every catalogue write');
});

test('a second run after the launch writes nothing and says already_live', async () => {
  const h = harness();
  await h.go(LAUNCH_DAY);
  const before = h.stripe.writes().length;
  const report = await h.go(LAUNCH_DAY + 3_600_000);
  assert.equal(report.mode, 'already_live');
  assert.equal(h.stripe.writes().length, before);
  assert.equal(h.alerts.length, 1);
});

test('a failed Stripe write stops before the flag and alerts once that day', async () => {
  const state = goodState();
  state.failPricePost = true;
  const h = harness(state);
  const report = await h.go(LAUNCH_DAY);
  assert.equal(report.mode, 'launch_failed');
  assert.equal(h.store.rows.get(EUR_LAUNCH_FLAG)?.enabled ?? false, false);
  await h.go(LAUNCH_DAY + 3_600_000);
  assert.deepEqual(h.alerts.map((a) => a.kind), ['launch_failed']);
  // Fixed: the next run launches.
  state.failPricePost = false;
  assert.equal((await h.go(LAUNCH_DAY + 7_200_000)).mode, 'launched');
});

test('a late registration (12-10) launches on the first run after it exists', async () => {
  const state = goodState();
  const oss = state.registrations.shift() as Obj;
  const h = harness(state);
  assert.equal((await h.go(LAUNCH_DAY)).mode, 'preflight_failed');
  state.registrations.unshift(oss);
  assert.equal((await h.go(Date.parse('2026-12-10T09:00:00.000Z'))).mode, 'launched');
});

test('dry run: preflight only, any date, no write and no alert', async () => {
  const state = goodState();
  state.registrations = [];
  const h = harness(state);
  const report = await h.go(BEFORE, { dryRun: true });
  assert.equal(report.mode, 'dry_run');
  assert.deepEqual(report.failed, ['tax_registrations']);
  assert.equal(h.stripe.writes().length, 0);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.store.rows.size, 0);
});

test('an unreadable flag is an error, never a launch', async () => {
  const h = harness();
  h.store.readFlag = async () => null;
  const report = await h.go(LAUNCH_DAY);
  assert.equal(report.mode, 'error');
  assert.equal(h.stripe.calls.length, 0);
});

// --- Legacy EU swap -------------------------------------------------------

function sub(id: string, customer: string, priceId: string, country: string, extra: Record<string, unknown> = {}): Obj {
  return {
    id,
    status: 'active',
    schedule: null,
    automatic_tax: { enabled: false },
    customer: { id: customer, address: { country }, tax: { automatic_tax: 'supported', location: { country } } },
    items: { data: [{ id: `si_${id}`, price: { id: priceId, metadata: {} } }] },
    ...extra,
  };
}

test('swap: EU subscribers move to a created twin with tax on, others are left alone', async () => {
  const state = goodState();
  state.subs = [
    sub('sub_de', 'cus_de', 'price_sm', 'DE'),
    sub('sub_fr', 'cus_fr', 'price_sm', 'FR'),
    sub('sub_us', 'cus_us', 'price_sm', 'US'),
    sub('sub_foreign', 'cus_x', 'price_other_product_line', 'DE'),
  ];
  const h = harness(state);
  const report = await h.go(LAUNCH_DAY);
  assert.equal(report.mode, 'launched');
  assert.equal(report.swap?.swapped, 2);
  assert.equal(report.swap?.twinsCreated, 1, 'one twin for the shared price');
  assert.equal(report.swap?.complete, true);
  const de = state.subs[0] as unknown as { items: { data: Array<{ price: Obj }> }; automatic_tax: { enabled: boolean } };
  assert.equal(de.items.data[0].price.tax_behavior, 'inclusive');
  assert.equal((de.items.data[0].price.metadata as Record<string, string>).twin_of, 'price_sm');
  assert.equal(de.automatic_tax.enabled, true);
  const us = state.subs[2] as unknown as { items: { data: Array<{ price: Obj }> }; automatic_tax: { enabled: boolean } };
  assert.equal(us.items.data[0].price.id, 'price_sm');
  assert.equal(us.automatic_tax.enabled, false);
  assert.equal(h.store.rows.get(EUR_SWAP_DONE_FLAG)?.enabled, true);
  // Done: a later run does not even list subscriptions.
  const listed = h.stripe.calls.filter((c) => c.path === '/v1/subscriptions').length;
  assert.equal((await h.go(LAUNCH_DAY + 3_600_000)).swap, null);
  assert.equal(h.stripe.calls.filter((c) => c.path === '/v1/subscriptions').length, listed);
});

test('swap pages under its cap and reuses the twin it made on the next run', async () => {
  const state = goodState();
  state.subs = Array.from({ length: 5 }, (_, i) => sub(`sub_${i}`, `cus_${i}`, 'price_bm', 'NL'));
  const h = harness(state);
  const first = await h.go(LAUNCH_DAY, { swapCap: 2 });
  assert.equal(first.swap?.swapped, 2);
  assert.equal(first.swap?.stoppedBy, 'cap');
  assert.equal(first.swap?.complete, false);
  assert.equal(h.store.rows.get(EUR_SWAP_DONE_FLAG)?.enabled ?? false, false);
  const second = await h.go(LAUNCH_DAY + 3_600_000, { swapCap: 2 });
  assert.equal(second.mode, 'already_live');
  assert.equal(second.swap?.swapped, 2);
  assert.equal(second.swap?.twinsCreated, 0, 'the twin from run one is found, not duplicated');
  assert.equal(second.swap?.skipped.already_done, 2);
  const third = await h.go(LAUNCH_DAY + 7_200_000, { swapCap: 2 });
  assert.equal(third.swap?.swapped, 1);
  assert.equal(third.swap?.complete, true);
  assert.equal(Object.keys(state.prices).filter((id) => id.startsWith('price_twin')).length, 1);
});

test('swap skips a customer Stripe Tax cannot locate and a subscription with a schedule', async () => {
  const state = goodState();
  const unlocated = sub('sub_a', 'cus_a', 'price_bm', 'DE');
  (unlocated.customer as { tax: { automatic_tax: string } }).tax.automatic_tax = 'unrecognized_location';
  state.subs = [unlocated, sub('sub_b', 'cus_b', 'price_bm', 'DE', { schedule: 'sub_sched_1' })];
  const h = harness(state);
  const report = await h.go(LAUNCH_DAY);
  assert.equal(report.swap?.swapped, 0);
  assert.deepEqual(report.swap?.skipped, { tax_location_unrecognized_location: 1, has_schedule: 1 });
});

test('swap failures alert once a day, carry no customer id, and never take the flag back', async () => {
  const state = goodState();
  state.subs = [sub('sub_de', 'cus_de', 'price_sm', 'DE')];
  state.failSubPost = true;
  const h = harness(state);
  const report = await h.go(LAUNCH_DAY);
  assert.equal(report.mode, 'launched');
  assert.equal(report.swap?.failed, 1);
  assert.equal(h.store.rows.get(EUR_LAUNCH_FLAG)?.enabled, true);
  await h.go(LAUNCH_DAY + 3_600_000);
  assert.deepEqual(h.alerts.map((a) => a.kind).sort(), ['live', 'swap_failed']);
  const text = JSON.stringify(h.alerts);
  assert.doesNotMatch(text, /cus_|sub_de/);
});
