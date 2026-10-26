#!/usr/bin/env node
/**
 * Builds the Stripe catalog for STAGING in the staging sandbox
 * (acct_1UUs5wPI08gnOkR5), mirroring production: every product and price the
 * web app reads from env, the Black Week coupons, a test promotion code, and
 * the webhook endpoint at staging.mcpemails.com. Then prints `NAME=value`
 * lines for the staging Vercel project.
 *
 * SAFETY. It refuses any key that is not sk_test_/rk_test_, and refuses
 * unless GET /v1/account answers with the sandbox's account id. There is no
 * flag to point it anywhere else.
 *
 * IDEMPOTENT. Products and prices carry metadata.staging_key and are found
 * by it on the next run; coupons have fixed ids; the promotion code is found
 * by its code and the webhook endpoint by its URL. Prices are immutable, so a
 * price that drifted from the spec (amount, interval, an EUR option) is
 * reported and the run fails: archive it in the Dashboard and re-run.
 *
 * Usage, from the repo root:
 *   node scripts/stripe-staging-setup.mjs [--dry-run] [--with-eur]
 *        [--env-file <path>] [--write-env] [--recreate-webhook]
 *
 *   --env-file <path>    where STRIPE_SECRET_KEY and STRIPE_PORTAL_CONFIGURATION_ID
 *                        are read from (default ~/.config/mcpemails-staging/staging.env;
 *                        the process environment wins). Never apps/web/.env.local.
 *   --write-env          upsert the printed lines into that env file (chmod 600).
 *                        The webhook secret is then masked on stdout.
 *   --with-eur           mirror prod AFTER the EUR launch: sold prices get
 *                        currency_options[eur] (same digits, inclusive; Japan
 *                        route 10800) and unspecified USD tax_behavior becomes
 *                        exclusive. Without it the catalog mirrors prod today,
 *                        so the launch path can be rehearsed in staging.
 *   --recreate-webhook   delete and recreate the staging endpoint to obtain a
 *                        new signing secret (Stripe shows it only at creation).
 *
 * The spec is STRIPE_SPEC.md in the staging tracker; the data lives in
 * scripts/staging-lib.mjs (tested by scripts/staging-lib.test.mjs).
 * The customer portal configuration already exists (created by hand to
 * mirror prod: cancel at period end, no pause, no plan switching); this
 * script only checks it and prints its id.
 */

import {
  COUPONS,
  DEFAULT_STAGING_ENV,
  PRICES,
  PRODUCTS,
  PROMOTION_CODE,
  STAGING_WEBHOOK_URL,
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENTS,
  assertStagingAccount,
  assertTestKey,
  couponDrift,
  formEncode,
  missingWebhookEvents,
  planPriceReconcile,
  priceCreateParams,
  readEnvFile,
  writeEnvFile,
} from './staging-lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const dryRun = flag('--dry-run');
const withEur = flag('--with-eur');
const writeEnv = flag('--write-env');
const recreateWebhook = flag('--recreate-webhook');
const envFile = option('--env-file') ?? DEFAULT_STAGING_ENV;

const fileEnv = readEnvFile(envFile);
const env = (name) => process.env[name] ?? fileEnv[name];

const key = env('STRIPE_SECRET_KEY');
assertTestKey(key);

// Pinned to the production webhook's version so request and payload shapes
// match prod (and promotion_codes still takes `coupon`).
async function stripe(method, path, params) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': WEBHOOK_API_VERSION,
    },
  };
  if (params && method === 'GET') {
    for (const [name, value] of formEncode(params)) url.searchParams.append(name, value);
  } else if (params) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = formEncode(params).toString();
  }
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`${method} /v1/${path} -> ${response.status} ${body?.error?.message ?? ''}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function listAll(path, params = {}) {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await stripe('GET', path, { limit: 100, ...params, starting_after: startingAfter });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) return out;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

const actions = [];
function act(line) {
  actions.push(line);
  console.error(`${dryRun ? '[dry-run] ' : ''}${line}`);
}

// ── 1. Account check ────────────────────────────────────────────────────────
const account = await stripe('GET', 'account');
assertStagingAccount(account.id);
console.error(`Stripe account ${account.id} (sandbox) ok.${dryRun ? ' Dry run: nothing is written.' : ''}`);

// ── 2. Products ─────────────────────────────────────────────────────────────
const existingProducts = await listAll('products');
const productIds = {};
for (const spec of PRODUCTS) {
  const want = {
    name: spec.name,
    description: spec.description,
    metadata: { ...spec.metadata, staging_key: `product:${spec.key}` },
    ...(spec.tax_code ? { tax_code: spec.tax_code } : {}),
    ...(spec.statement_descriptor ? { statement_descriptor: spec.statement_descriptor } : {}),
  };
  const found = existingProducts.find((p) => p.metadata?.staging_key === `product:${spec.key}`);
  if (!found) {
    act(`create product ${spec.name}`);
    productIds[spec.key] = dryRun ? `(new:${spec.key})` : (await stripe('POST', 'products', want)).id;
    continue;
  }
  productIds[spec.key] = found.id;
  const differs =
    found.name !== want.name ||
    found.description !== want.description ||
    !found.active ||
    (want.tax_code && found.tax_code !== want.tax_code) ||
    (want.statement_descriptor && found.statement_descriptor !== want.statement_descriptor) ||
    Object.entries(want.metadata).some(([k, v]) => found.metadata?.[k] !== v);
  if (differs) {
    act(`update product ${found.id} (${spec.name})`);
    if (!dryRun) await stripe('POST', `products/${found.id}`, { ...want, active: true });
  }
}

// ── 3. Prices ───────────────────────────────────────────────────────────────
const existingPrices = await listAll('prices', { expand: ['data.currency_options'] });
const priceIds = {};
const drifted = [];
for (const spec of PRICES) {
  const found = existingPrices.find((p) => p.metadata?.staging_key === spec.env);
  if (!found) {
    act(`create price ${spec.env} (${spec.amount} usd/${spec.interval ?? 'once'})`);
    if (dryRun) {
      priceIds[spec.env] = `(new:${spec.env})`;
    } else {
      const created = await stripe('POST', 'prices', priceCreateParams(spec, productIds[spec.product], withEur));
      priceIds[spec.env] = created.id;
    }
    continue;
  }
  priceIds[spec.env] = found.id;
  const productId = typeof found.product === 'string' ? found.product : found.product?.id;
  const { drift, update } = planPriceReconcile(found, spec, withEur);
  if (productId !== productIds[spec.product]) drift.push(`product ${productId} != ${productIds[spec.product]}`);
  if (drift.length) {
    drifted.push(`${spec.env} ${found.id}: ${drift.join('; ')}`);
    continue;
  }
  if (update) {
    act(`update price ${spec.env} ${found.id}: ${Object.keys(update).join(', ')}`);
    if (!dryRun) await stripe('POST', `prices/${found.id}`, update);
  }
}
if (drifted.length) {
  console.error(
    '\nThese prices differ from the spec and prices are immutable. Archive each one ' +
      '(and clear its metadata.staging_key) in the sandbox Dashboard, then re-run:',
  );
  for (const line of drifted) console.error(`  ${line}`);
  process.exit(1);
}

// ── 4. Coupons and the test promotion code ──────────────────────────────────
for (const spec of COUPONS) {
  let found = null;
  try {
    found = await stripe('GET', `coupons/${spec.id}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (found) {
    const drift = couponDrift(found, spec);
    if (drift.length) throw new Error(`Coupon ${spec.id} differs from the spec in ${drift.join(', ')}; delete it in the Dashboard and re-run.`);
    continue;
  }
  if (spec.redeem_by && spec.redeem_by * 1000 <= Date.now()) {
    console.error(`Skipping coupon ${spec.id}: its redeem_by is in the past, Stripe would refuse it.`);
    continue;
  }
  act(`create coupon ${spec.id}`);
  if (!dryRun) await stripe('POST', 'coupons', { ...spec, metadata: { staging_key: `coupon:${spec.id}` } });
}

const promos = await stripe('GET', 'promotion_codes', { code: PROMOTION_CODE.code, limit: 10 });
const activePromo = promos.data.find((p) => p.active);
if (!activePromo) {
  act(`create promotion code ${PROMOTION_CODE.code} on ${PROMOTION_CODE.coupon}`);
  if (!dryRun) {
    await stripe('POST', 'promotion_codes', {
      coupon: PROMOTION_CODE.coupon,
      code: PROMOTION_CODE.code,
      metadata: { staging_key: 'promotion_code:test' },
    });
  }
}

// ── 5. Webhook endpoint ─────────────────────────────────────────────────────
let webhookSecret = null;
const endpoints = await listAll('webhook_endpoints');
let endpoint = endpoints.find((e) => e.url === STAGING_WEBHOOK_URL) ?? null;
if (endpoint && recreateWebhook) {
  act(`delete webhook endpoint ${endpoint.id} (recreate for a new secret)`);
  if (!dryRun) await stripe('DELETE', `webhook_endpoints/${endpoint.id}`);
  endpoint = null;
}
if (!endpoint) {
  act(`create webhook endpoint ${STAGING_WEBHOOK_URL} (${WEBHOOK_EVENTS.length} events, ${WEBHOOK_API_VERSION})`);
  if (!dryRun) {
    const created = await stripe('POST', 'webhook_endpoints', {
      url: STAGING_WEBHOOK_URL,
      enabled_events: [...WEBHOOK_EVENTS],
      api_version: WEBHOOK_API_VERSION,
      description: 'MCPEmails staging (scripts/stripe-staging-setup.mjs)',
      metadata: { staging_key: 'webhook:staging' },
    });
    webhookSecret = created.secret;
  }
} else {
  const missing = missingWebhookEvents(endpoint.enabled_events ?? []);
  if (missing.length || endpoint.status !== 'enabled') {
    act(`update webhook endpoint ${endpoint.id}: add ${missing.join(', ') || 'none'}; enable`);
    if (!dryRun) {
      await stripe('POST', `webhook_endpoints/${endpoint.id}`, {
        enabled_events: [...new Set([...(endpoint.enabled_events ?? []), ...WEBHOOK_EVENTS])],
        disabled: false,
      });
    }
  }
  if (!env('STRIPE_WEBHOOK_SECRET')) {
    console.error(
      'The webhook endpoint exists but STRIPE_WEBHOOK_SECRET is not in the env file. ' +
        'Stripe shows a secret only at creation: re-run with --recreate-webhook.',
    );
  }
}

// ── 6. Customer portal (exists; check only) ─────────────────────────────────
const portalId = env('STRIPE_PORTAL_CONFIGURATION_ID');
if (!portalId) throw new Error('STRIPE_PORTAL_CONFIGURATION_ID is not set in the env file.');
const portal = await stripe('GET', `billing_portal/configurations/${portalId}`);
const portalProblems = [];
if (!portal.active) portalProblems.push('inactive');
if (portal.features?.subscription_update?.enabled) portalProblems.push('plan switching is on (prod: off)');
if (portal.features?.subscription_pause?.enabled) portalProblems.push('pause is on (prod: off)');
if (!portal.features?.subscription_cancel?.enabled) portalProblems.push('cancel is off (prod: on)');
if (portal.features?.subscription_cancel?.mode !== 'at_period_end') portalProblems.push('cancel is not at period end');
if (portalProblems.length) console.error(`Portal ${portalId} differs from prod: ${portalProblems.join('; ')}`);

// ── 7. Output ───────────────────────────────────────────────────────────────
const lines = { ...priceIds, STRIPE_PORTAL_CONFIGURATION_ID: portalId };
if (webhookSecret) lines.STRIPE_WEBHOOK_SECRET = webhookSecret;

if (writeEnv && !dryRun) {
  writeEnvFile(envFile, lines);
  console.error(`\nWrote ${Object.keys(lines).length} lines to ${envFile} (chmod 600).`);
}
console.log('# Stripe staging sandbox, from scripts/stripe-staging-setup.mjs');
console.log('# STRIPE_PRICE_TWINS, STRIPE_PMC_ID, STRIPE_EUR_PRICES, STRIPE_AUTOMATIC_TAX: leave unset (prod defaults).');
for (const [name, value] of Object.entries(lines)) {
  const masked = name === 'STRIPE_WEBHOOK_SECRET' && writeEnv ? 'whsec_... (written to the env file)' : value;
  console.log(`${name}=${masked}`);
}
if (!webhookSecret && !dryRun) console.log('# STRIPE_WEBHOOK_SECRET unchanged (endpoint already existed).');
console.error(`\n${actions.length} change(s)${dryRun ? ' planned' : ' made'}.`);
