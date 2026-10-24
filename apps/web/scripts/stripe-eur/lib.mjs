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
// The sold-price list, the EU list and every pure planner live in
// src/lib/stripe/eur-launch-plan.ts since the launch became automatic: the
// dispatcher (app/api/internal/eur-launch/dispatch) runs the same rules on
// its date, and a currency option is permanent, so there is one copy of
// "what does this price need", not two. Re-exported here so these scripts
// and lib.test.mjs keep their imports.
// ---------------------------------------------------------------------------
import {
  BILLING_STATUSES,
  DEFAULT_TAX_CODE,
  EU_COUNTRIES,
  LEGACY_PRICE_ENV,
  SOLD_PRICE_ENV,
  coveredCountries,
  customerCountry,
  flattenParams,
  isTwinOf,
  listAll,
  makeFetchTransport,
  planPriceUpdate,
  planProductUpdate,
  planSwap,
  priceIdsFromEnv,
  twinCreateParams,
} from '../../src/lib/stripe/eur-launch-plan.ts';

export {
  BILLING_STATUSES,
  DEFAULT_TAX_CODE,
  EU_COUNTRIES,
  SOLD_PRICE_ENV,
  coveredCountries,
  customerCountry,
  isTwinOf,
  listAll,
  planPriceUpdate,
  planProductUpdate,
  planSwap,
  twinCreateParams,
};

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
  const merged = {};
  for (const name of [...SOLD_PRICE_ENV.map((p) => p.env), ...LEGACY_PRICE_ENV]) {
    merged[name] = fromFile[name] ?? env[name];
  }
  return priceIdsFromEnv(merged);
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
// Stripe transport
// ---------------------------------------------------------------------------
export function makeStripe({ live, env = process.env }) {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (key) return makeFetchTransport({ key, live });
  return {
    transport: 'stripe-cli',
    async request(method, path, params = {}, { idempotencyKey } = {}) {
      const args = [method === 'GET' ? 'get' : 'post', path];
      for (const [k, v] of flattenParams(params)) args.push('-d', `${k}=${v}`);
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
