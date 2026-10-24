// ---------------------------------------------------------------------------
// Shared helpers for the EUR launch scripts in this folder. The runbook is
// docs/RUNBOOK-eur-launch.md.
//
// TRANSPORT. Two ways to reach Stripe, picked at start-up:
//   1. STRIPE_SECRET_KEY in the environment: plain fetch to api.stripe.com
//      (the same approach as scripts/verify-pro-v2-prices.mjs). The key's mode
//      must match the flags: an `sk_live_`/`rk_live_` key needs `--live`, a
//      test key must not have it. A mismatch exits before any request.
//   2. No key: the Stripe CLI (`stripe get|post <path> [--live]`), using the
//      profile the CLI is logged in with. Its output can start with a non-JSON
//      byte, so the body is parsed from the first `{`.
// No npm Stripe SDK on purpose: the scripts run with plain `node` from
// apps/web and must not depend on the SDK's pinned API version.
//
// Pure planning functions are exported separately and unit-tested in
// lib.test.mjs (suite test:plans). Nothing here writes unless a caller passes
// `apply`.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPS_WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = resolve(APPS_WEB, '..', '..');

// ---------------------------------------------------------------------------
// The sold prices, by the environment variable that holds each id.
// `eurCents: 'same'` means "the same digits as the USD unit_amount" (owner
// decision 2026-10-24). `usdCents` is what the catalogue says the USD price
// must be; a price that differs is reported and never touched.
// ---------------------------------------------------------------------------
export const SOLD_PRICE_ENV = [
  { env: 'STRIPE_PRICE_PERSONAL_MONTHLY_V2', usdCents: 900, interval: 'month' },
  { env: 'STRIPE_PRICE_PERSONAL_YEARLY_V2', usdCents: 8640, interval: 'year' },
  { env: 'STRIPE_PRICE_SOLO_MONTHLY', usdCents: 1500, interval: 'month' },
  { env: 'STRIPE_PRICE_SOLO_YEARLY', usdCents: 14400, interval: 'year' },
  // Pro $19 / $182.40 (PR #241). Optional until the V2 prices exist.
  { env: 'STRIPE_PRICE_SOLO_MONTHLY_V2', usdCents: 1900, interval: 'month', optional: true },
  { env: 'STRIPE_PRICE_SOLO_YEARLY_V2', usdCents: 18240, interval: 'year', optional: true },
  { env: 'STRIPE_PRICE_BUSINESS_MONTHLY', usdCents: 3900, interval: 'month' },
  { env: 'STRIPE_PRICE_BUSINESS_YEARLY', usdCents: 37440, interval: 'year' },
  { env: 'STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY', usdCents: 300, interval: 'month' },
  { env: 'STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY', usdCents: 2880, interval: 'year' },
  // The Japan sending route is sold from the Dashboard, not from code, so this
  // variable exists only for these scripts. EUR 108, not 120 (owner decision).
  { env: 'STRIPE_PRICE_JAPAN_ROUTE_YEARLY', usdCents: 12000, eurCents: 10800, interval: 'year', optional: true },
];

export const DEFAULT_TAX_CODE = 'txcd_10000000';

// EU member states (ISO 3166-1 alpha-2). Greece is GR here, as Stripe reports it.
export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Statuses that still bill and therefore need the right price. */
export const BILLING_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { apply: false, live: false, prices: null, twins: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--live') out.live = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--prices') out.prices = argv[++i];
    else if (a === '--twins') out.twins = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/**
 * Price ids by env var name. A `--prices` file (JSON object, env name -> id)
 * wins over process.env, so a rehearsal can point at test-mode ids without
 * exporting anything.
 */
export function loadPriceEnv(pricesFile, env = process.env) {
  const fromFile = pricesFile ? JSON.parse(readFileSync(pricesFile, 'utf8')) : {};
  const ids = {};
  for (const name of [...SOLD_PRICE_ENV.map((p) => p.env), 'STRIPE_PRICE_PERSONAL_MONTHLY',
    'STRIPE_PRICE_PERSONAL_YEARLY', 'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_YEARLY']) {
    const v = (fromFile[name] ?? env[name] ?? '').trim();
    if (v) ids[name] = v;
  }
  return ids;
}

/**
 * Every MCPEmails price id, sold and legacy, read from plans.ts after the
 * env is set from `ids`. The account also carries another product line's
 * prices, so subscriptions are always filtered to this set.
 */
export async function loadCatalogueIds(ids) {
  for (const [k, v] of Object.entries(ids)) process.env[k] = v;
  const plans = await import('../../src/lib/stripe/plans.ts');
  const set = new Set();
  for (const plan of Object.values(plans.PLANS)) {
    for (const id of [plan.stripePriceIdMonthly, plan.stripePriceIdYearly, ...plan.legacyStripePriceIds]) {
      if (id) set.add(id);
    }
  }
  for (const id of [plans.mailboxAddonPriceId('month'), plans.mailboxAddonPriceId('year')]) {
    if (id) set.add(id);
  }
  for (const id of Object.values(ids)) set.add(id);
  return set;
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/**
 * What one sold price needs. Returns { problems, params } where params is the
 * form body for POST /v1/prices/:id, or null when nothing needs to change.
 * The price must be retrieved with expand[]=currency_options, or Stripe leaves
 * the field out and every price would look like it needs an EUR option.
 */
export function planPriceUpdate(price, spec) {
  const problems = [];
  if (!price || price.object !== 'price') return { problems: ['not a Stripe price'], params: null };
  if (price.currency !== 'usd') problems.push(`currency ${price.currency}, expected usd`);
  if (price.unit_amount !== spec.usdCents) problems.push(`unit_amount ${price.unit_amount}, expected ${spec.usdCents}`);
  if (price.recurring?.interval !== spec.interval) problems.push(`interval ${price.recurring?.interval}, expected ${spec.interval}`);
  if (!price.active) problems.push('price is archived');
  if (problems.length) return { problems, params: null };

  const eurCents = spec.eurCents ?? price.unit_amount;
  const params = {};
  if (price.tax_behavior === 'unspecified') params.tax_behavior = 'exclusive';
  else if (price.tax_behavior !== 'exclusive') problems.push(`USD tax_behavior is ${price.tax_behavior}; left as is`);

  const eur = price.currency_options?.eur;
  if (!eur) {
    params['currency_options[eur][unit_amount]'] = String(eurCents);
    params['currency_options[eur][tax_behavior]'] = 'inclusive';
  } else if (eur.unit_amount !== eurCents || eur.tax_behavior !== 'inclusive') {
    // An existing currency option is immutable (Stripe: "attempting to update
    // an immutable field for an existing currency"). Report, never retry.
    problems.push(`EUR option exists as ${eur.unit_amount} ${eur.tax_behavior}, wanted ${eurCents} inclusive; immutable, fix by hand`);
  }
  return { problems, params: Object.keys(params).length ? params : null };
}

/** POST /v1/products/:id params, or null when the product already has a code. */
export function planProductUpdate(product, taxCode = DEFAULT_TAX_CODE) {
  const current = typeof product.tax_code === 'string' ? product.tax_code : product.tax_code?.id;
  return current ? null : { tax_code: taxCode };
}

/** Body for creating the inclusive USD twin of `price`. */
export function twinCreateParams(price) {
  const product = typeof price.product === 'string' ? price.product : price.product.id;
  const label = price.nickname || `${price.unit_amount} ${price.currency} per ${price.recurring?.interval}`;
  return {
    currency: price.currency,
    unit_amount: String(price.unit_amount),
    product,
    'recurring[interval]': price.recurring.interval,
    'recurring[interval_count]': String(price.recurring.interval_count ?? 1),
    'recurring[usage_type]': price.recurring.usage_type ?? 'licensed',
    tax_behavior: 'inclusive',
    nickname: `${label} (incl. VAT)`,
    'metadata[twin_of]': price.id,
  };
}

/** Is `candidate` a usable twin of `original`? */
export function isTwinOf(candidate, original) {
  return (
    candidate.active === true &&
    candidate.metadata?.twin_of === original.id &&
    candidate.tax_behavior === 'inclusive' &&
    candidate.currency === original.currency &&
    candidate.unit_amount === original.unit_amount &&
    candidate.recurring?.interval === original.recurring?.interval &&
    (candidate.recurring?.interval_count ?? 1) === (original.recurring?.interval_count ?? 1)
  );
}

/**
 * The buyer's country, in the order plan section 0 used: card country of the
 * latest succeeded charge, then that charge's billing address, then the
 * customer's address, then Stripe Tax's own location. Returns { country, source }.
 */
export function customerCountry({ charge, customer }) {
  const candidates = [
    ['card', charge?.payment_method_details?.card?.country],
    ['charge_billing', charge?.billing_details?.address?.country],
    ['customer_address', customer?.address?.country],
    ['tax_location', customer?.tax?.location?.country],
  ];
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.length === 2) return { country: value.toUpperCase(), source };
  }
  return { country: null, source: 'unknown' };
}

/**
 * Countries Stripe Tax collects in, from active registrations. A non-Union or
 * Union OSS registration covers every member state.
 */
export function coveredCountries(registrations) {
  const set = new Set();
  for (const reg of registrations ?? []) {
    if (reg.status && reg.status !== 'active') continue;
    const options = Object.values(reg.country_options ?? {});
    if (options.some((o) => typeof o?.type === 'string' && o.type.startsWith('oss'))) {
      for (const c of EU_COUNTRIES) set.add(c);
    }
    if (reg.country) set.add(reg.country.toUpperCase());
  }
  return set;
}

/**
 * The swap for one subscription, given twin lookups. Returns
 * { action: 'swap'|'skip', reason?, items? } where items are
 * [{ id, price }] for POST /v1/subscriptions/:id.
 */
export function planSwap(sub, { twinByOriginal, originalByTwin, catalogue }) {
  if (sub.schedule) return { action: 'skip', reason: 'has_schedule' };
  const items = sub.items?.data ?? [];
  const mine = items.filter((it) => catalogue.has(it.price?.id) || originalByTwin.has(it.price?.id));
  if (!mine.length) return { action: 'skip', reason: 'not_mcpemails' };
  const changes = [];
  for (const it of items) {
    const id = it.price?.id;
    if (originalByTwin.has(id)) continue;
    const twin = twinByOriginal.get(id);
    if (!twin) return { action: 'skip', reason: 'missing_twin' };
    changes.push({ id: it.id, price: twin });
  }
  const taxOn = sub.automatic_tax?.enabled === true;
  if (!changes.length && taxOn) return { action: 'skip', reason: 'already_done' };
  return { action: 'swap', items: changes };
}

// ---------------------------------------------------------------------------
// Stripe transport
// ---------------------------------------------------------------------------
export function makeStripe({ live, env = process.env }) {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (key) {
    const keyLive = key.includes('_live_');
    if (keyLive !== live) {
      throw new Error(keyLive
        ? 'STRIPE_SECRET_KEY is a live key: pass --live to target live mode.'
        : 'STRIPE_SECRET_KEY is a test key but --live was passed.');
    }
    return {
      transport: 'fetch',
      async request(method, path, params = {}, { idempotencyKey } = {}) {
        const body = new URLSearchParams(flatten(params));
        const url = method === 'GET' ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
        const headers = { Authorization: `Bearer ${key}` };
        if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
        const json = await res.json();
        if (!res.ok) throw new Error(`${method} ${path}: ${json?.error?.message ?? res.status}`);
        return json;
      },
    };
  }
  return {
    transport: 'stripe-cli',
    async request(method, path, params = {}, { idempotencyKey } = {}) {
      const args = [method === 'GET' ? 'get' : 'post', path];
      for (const [k, v] of flatten(params)) args.push('-d', `${k}=${v}`);
      if (idempotencyKey && method !== 'GET') args.push('-i', idempotencyKey);
      if (live) args.push('--live');
      const raw = execFileSync('stripe', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const start = raw.indexOf('{');
      if (start === -1) throw new Error(`${method} ${path}: no JSON in CLI output`);
      const json = JSON.parse(raw.slice(start));
      if (json.error) throw new Error(`${method} ${path}: ${json.error.message}`);
      return json;
    },
  };
}

/** `{ a: [x, y] }` -> [['a[]', x], ['a[]', y]]; plain entries pass through. */
function flatten(params) {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) out.push([`${k}[]`, String(x)]);
    else out.push([k, String(v)]);
  }
  return out;
}

/** Every object of a list endpoint, following `starting_after`. */
export async function listAll(stripe, path, params = {}) {
  const all = [];
  let startingAfter;
  for (;;) {
    const page = await stripe.request('GET', path, { limit: 100, ...params, starting_after: startingAfter });
    all.push(...page.data);
    if (!page.has_more || !page.data.length) return all;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

/**
 * Billing MCPEmails subscriptions with their buyer country. Customer and the
 * Stripe Tax location are expanded; the latest succeeded charge is one extra
 * call per customer.
 */
export async function loadBillingSubscriptions(stripe, catalogue, originalByTwin = new Map()) {
  const subs = [];
  for (const status of BILLING_STATUSES) {
    const page = await listAll(stripe, '/v1/subscriptions', {
      status,
      expand: ['data.customer', 'data.customer.tax'],
    });
    subs.push(...page);
  }
  const mine = subs.filter((s) =>
    (s.items?.data ?? []).some((it) => catalogue.has(it.price?.id) || originalByTwin.has(it.price?.id)),
  );
  const chargeByCustomer = new Map();
  for (const sub of mine) {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (!customerId || chargeByCustomer.has(customerId)) continue;
    const charges = await stripe.request('GET', '/v1/charges', { customer: customerId, limit: 10 });
    chargeByCustomer.set(customerId, charges.data.find((c) => c.status === 'succeeded') ?? null);
  }
  return mine.map((sub) => {
    const customer = typeof sub.customer === 'string' ? null : sub.customer;
    const charge = chargeByCustomer.get(customer?.id ?? sub.customer) ?? null;
    return { sub, customer, ...customerCountry({ charge, customer }) };
  });
}

// ---------------------------------------------------------------------------
// Output files hold account data (price and subscription ids, counts per
// price). They must never land in git: inside the repo, only gitignored paths.
// ---------------------------------------------------------------------------
export function writeAccountFile(path, data) {
  const abs = resolve(path);
  if (abs.startsWith(REPO_ROOT + '/')) {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', abs]);
    } catch {
      throw new Error(`${abs} is inside the repo and not gitignored; write it under Documents/ instead.`);
    }
  }
  if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  return abs;
}

export function modeLabel(live) {
  return live ? 'LIVE' : 'test';
}
