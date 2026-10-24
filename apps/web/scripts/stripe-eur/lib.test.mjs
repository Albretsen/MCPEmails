// Pure planning in the EUR launch scripts (scripts/stripe-eur/lib.mjs).
// Fixtures only; nothing here talks to Stripe.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EU_COUNTRIES,
  SOLD_PRICE_ENV,
  coveredCountries,
  customerCountry,
  isTwinOf,
  makeStripe,
  parseArgs,
  planPriceUpdate,
  planProductUpdate,
  planSwap,
  twinCreateParams,
} from './lib.mjs';

const spec = (env) => SOLD_PRICE_ENV.find((s) => s.env === env);

function price(over = {}) {
  return {
    object: 'price',
    id: 'price_a',
    active: true,
    currency: 'usd',
    unit_amount: 900,
    tax_behavior: 'exclusive',
    product: 'prod_a',
    nickname: 'Personal-Monthly',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: {},
    currency_options: { usd: { unit_amount: 900, tax_behavior: 'exclusive' } },
    ...over,
  };
}

test('EUR is added inclusive with the same digits as USD', () => {
  const { problems, params } = planPriceUpdate(price(), spec('STRIPE_PRICE_PERSONAL_MONTHLY_V2'));
  assert.deepEqual(problems, []);
  assert.deepEqual(params, {
    'currency_options[eur][unit_amount]': '900',
    'currency_options[eur][tax_behavior]': 'inclusive',
  });
});

test('an unspecified USD price is set exclusive in the same call', () => {
  const p = price({ unit_amount: 37440, tax_behavior: 'unspecified', recurring: { interval: 'year' } });
  const { params } = planPriceUpdate(p, spec('STRIPE_PRICE_BUSINESS_YEARLY'));
  assert.equal(params.tax_behavior, 'exclusive');
  assert.equal(params['currency_options[eur][unit_amount]'], '37440');
});

test('the Japan route is EUR 108, not 120', () => {
  const p = price({ unit_amount: 12000, tax_behavior: 'unspecified', recurring: { interval: 'year' } });
  const { params } = planPriceUpdate(p, spec('STRIPE_PRICE_JAPAN_ROUTE_YEARLY'));
  assert.equal(params['currency_options[eur][unit_amount]'], '10800');
});

test('idempotent: a price already right needs nothing', () => {
  const p = price({ currency_options: { eur: { unit_amount: 900, tax_behavior: 'inclusive' } } });
  assert.deepEqual(planPriceUpdate(p, spec('STRIPE_PRICE_PERSONAL_MONTHLY_V2')), { problems: [], params: null });
});

test('a wrong existing EUR option is reported, never rewritten (immutable)', () => {
  const p = price({ currency_options: { eur: { unit_amount: 1000, tax_behavior: 'inclusive' } } });
  const { problems, params } = planPriceUpdate(p, spec('STRIPE_PRICE_PERSONAL_MONTHLY_V2'));
  assert.equal(params, null);
  assert.match(problems[0], /immutable/);
});

test('a price that is not what the catalogue sells is never touched', () => {
  for (const p of [
    price({ unit_amount: 500 }),
    price({ currency: 'eur' }),
    price({ recurring: { interval: 'year' } }),
    price({ active: false }),
  ]) {
    const { problems, params } = planPriceUpdate(p, spec('STRIPE_PRICE_PERSONAL_MONTHLY_V2'));
    assert.equal(params, null);
    assert.ok(problems.length > 0);
  }
});

test('products get the default tax code only when they have none', () => {
  assert.deepEqual(planProductUpdate({ tax_code: null }), { tax_code: 'txcd_10000000' });
  assert.equal(planProductUpdate({ tax_code: 'txcd_10103000' }), null);
  assert.equal(planProductUpdate({ tax_code: { id: 'txcd_10000000' } }), null);
});

test('a twin copies amount, interval and product, inclusive, and points back', () => {
  const original = price({ id: 'price_orig', nickname: 'Pro-Monthly', unit_amount: 1500 });
  const params = twinCreateParams(original);
  assert.deepEqual(params, {
    currency: 'usd',
    unit_amount: '1500',
    product: 'prod_a',
    'recurring[interval]': 'month',
    'recurring[interval_count]': '1',
    'recurring[usage_type]': 'licensed',
    tax_behavior: 'inclusive',
    nickname: 'Pro-Monthly (incl. VAT)',
    'metadata[twin_of]': 'price_orig',
  });
  const twin = price({ id: 'price_twin', unit_amount: 1500, tax_behavior: 'inclusive', metadata: { twin_of: 'price_orig' } });
  assert.equal(isTwinOf(twin, original), true);
  assert.equal(isTwinOf({ ...twin, unit_amount: 1900 }, original), false);
  assert.equal(isTwinOf({ ...twin, active: false }, original), false);
  assert.equal(isTwinOf({ ...twin, tax_behavior: 'exclusive' }, original), false);
  // A nameless price still gets a readable nickname.
  assert.equal(twinCreateParams(price({ nickname: null })).nickname, '900 usd per month (incl. VAT)');
});

test('country: card first, then billing, then customer address, then tax location', () => {
  assert.deepEqual(
    customerCountry({
      charge: { payment_method_details: { card: { country: 'de' } }, billing_details: { address: { country: 'FR' } } },
      customer: { address: { country: 'NO' } },
    }),
    { country: 'DE', source: 'card' },
  );
  assert.deepEqual(customerCountry({ charge: { billing_details: { address: { country: 'FR' } } } }), { country: 'FR', source: 'charge_billing' });
  assert.deepEqual(customerCountry({ customer: { address: { country: 'ES' } } }), { country: 'ES', source: 'customer_address' });
  assert.deepEqual(customerCountry({ customer: { tax: { location: { country: 'IT' } } } }), { country: 'IT', source: 'tax_location' });
  assert.deepEqual(customerCountry({}), { country: null, source: 'unknown' });
  assert.equal(EU_COUNTRIES.has('NO'), false);
  assert.equal(EU_COUNTRIES.has('GB'), false);
  assert.equal(EU_COUNTRIES.size, 27);
});

test('an OSS registration covers all 27; a plain one covers its country', () => {
  assert.equal(coveredCountries([]).size, 0);
  const oss = coveredCountries([{ status: 'active', country: 'IE', country_options: { ie: { type: 'oss_non_union' } } }]);
  assert.equal(oss.size, 27);
  const no = coveredCountries([{ status: 'active', country: 'NO', country_options: { no: { type: 'standard' } } }]);
  assert.deepEqual([...no], ['NO']);
  assert.equal(coveredCountries([{ status: 'expired', country: 'IE', country_options: { ie: { type: 'oss_non_union' } } }]).size, 0);
});

test('swap plan: every item to its twin, or nothing', () => {
  const twinByOriginal = new Map([['price_base', 'price_base_twin'], ['price_addon', 'price_addon_twin']]);
  const originalByTwin = new Map([['price_base_twin', 'price_base'], ['price_addon_twin', 'price_addon']]);
  const catalogue = new Set(['price_base', 'price_addon', 'price_other']);
  const ctx = { twinByOriginal, originalByTwin, catalogue };
  const sub = (items, extra = {}) => ({ items: { data: items.map(([id, p]) => ({ id, price: { id: p } })) }, ...extra });

  assert.deepEqual(planSwap(sub([['si_1', 'price_base'], ['si_2', 'price_addon']]), ctx), {
    action: 'swap',
    items: [{ id: 'si_1', price: 'price_base_twin' }, { id: 'si_2', price: 'price_addon_twin' }],
  });
  assert.deepEqual(planSwap(sub([['si_1', 'price_base'], ['si_2', 'price_other']]), ctx), { action: 'skip', reason: 'missing_twin' });
  assert.deepEqual(planSwap(sub([['si_1', 'price_harbor']]), ctx), { action: 'skip', reason: 'not_mcpemails' });
  assert.deepEqual(planSwap(sub([['si_1', 'price_base']], { schedule: 'sub_sched_1' }), ctx), { action: 'skip', reason: 'has_schedule' });
  // Already on twins with automatic tax: done. On twins without it: turn tax on only.
  assert.deepEqual(
    planSwap(sub([['si_1', 'price_base_twin']], { automatic_tax: { enabled: true } }), ctx),
    { action: 'skip', reason: 'already_done' },
  );
  assert.deepEqual(planSwap(sub([['si_1', 'price_base_twin']]), ctx), { action: 'swap', items: [] });
});

test('the key mode must match --live', () => {
  assert.throws(() => makeStripe({ live: false, env: { STRIPE_SECRET_KEY: 'rk_live_x' } }), /pass --live/);
  assert.throws(() => makeStripe({ live: true, env: { STRIPE_SECRET_KEY: 'sk_test_x' } }), /test key/);
  assert.equal(makeStripe({ live: true, env: { STRIPE_SECRET_KEY: 'sk_live_x' } }).transport, 'fetch');
  assert.equal(makeStripe({ live: true, env: {} }).transport, 'stripe-cli');
});

test('arguments: dry run unless --apply; unknown flags refused', () => {
  assert.deepEqual(parseArgs([]), { apply: false, live: false, prices: null, twins: null, out: null, help: false });
  assert.equal(parseArgs(['--apply', '--live']).apply, true);
  assert.equal(parseArgs(['--prices', 'p.json']).prices, 'p.json');
  assert.throws(() => parseArgs(['--force']), /unknown argument/);
});
