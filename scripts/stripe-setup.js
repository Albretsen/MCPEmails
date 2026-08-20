#!/usr/bin/env node
/**
 * stripe-setup.js
 *
 * One-time script that creates the MCPEmails Stripe products and prices,
 * then patches apps/web/.env.local with the resulting price IDs.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.js
 *
 * What it creates (the 2026-08-19 catalogue; the value metric is connected
 * inboxes, so there are exactly two paid tiers and no usage add-on):
 *   - Product "MCPEmails Pro"  → price $29/mo  +  $276/yr
 *   - Product "MCPEmails Team" → price $79/mo  +  $756/yr
 *
 * The env var names lag the customer-facing names by one rename and are kept
 * that way so no environment has to be re-keyed: Pro writes STRIPE_PRICE_SOLO_*
 * and Team writes STRIPE_PRICE_PRO_*, matching the `solo` and `pro` plan ids in
 * the database. There is no Enterprise tier: this script used to provision one,
 * and nothing has ever read STRIPE_PRICE_ENTERPRISE_*.
 *
 * Prices are created with tax_behavior=exclusive so Stripe Tax can be switched
 * on later without a price migration. (It is off today: the account holds no
 * tax registrations, so it would calculate zero everywhere.)
 *
 * After running, commit nothing — the .env.local changes are local only.
 * Add the same four STRIPE_PRICE_* vars to your Vercel project via the
 * Vercel dashboard or `vercel env add`.
 *
 * Safe to run multiple times: if a product with the same name already
 * exists it is reused; new prices are only created if none exist yet for
 * the matching amount + interval combination.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!SECRET_KEY || SECRET_KEY === 'sk_test_placeholder') {
  console.error(
    '\n  ❌  STRIPE_SECRET_KEY is not set or is still a placeholder.\n' +
    '     Run:  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.js\n',
  );
  process.exit(1);
}

const ENV_FILE = path.resolve(__dirname, '../apps/web/.env.local');

const PRODUCTS = [
  {
    // Sold as "Pro"; internal plan id `solo`, hence the SOLO env vars.
    name: 'MCPEmails Pro',
    description: 'Every mailbox you own, in one agent. Unlimited connected inboxes, one person.',
    prices: [
      { unit_amount: 2900,  currency: 'usd', interval: 'month', envVar: 'STRIPE_PRICE_SOLO_MONTHLY' },
      { unit_amount: 27600, currency: 'usd', interval: 'year',  envVar: 'STRIPE_PRICE_SOLO_YEARLY' },
    ],
  },
  {
    // Sold as "Team"; internal plan id `pro`, hence the PRO env vars.
    name: 'MCPEmails Team',
    description: 'Shared inboxes for a team, with a separate workspace per client or business.',
    prices: [
      { unit_amount: 7900,  currency: 'usd', interval: 'month', envVar: 'STRIPE_PRICE_PRO_MONTHLY' },
      { unit_amount: 75600, currency: 'usd', interval: 'year',  envVar: 'STRIPE_PRICE_PRO_YEARLY' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Stripe API helper (no npm dependency — uses built-in https)
// ---------------------------------------------------------------------------

function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const body = params ? new URLSearchParams(params).toString() : '';

    const options = {
      hostname: 'api.stripe.com',
      path: `/v1${path}`,
      method,
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Stripe-Version': '2025-04-30.basil',
        'User-Agent': 'MCPEmails-setup-script/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          reject(new Error(`Stripe error (${res.statusCode}): ${parsed.error.message}`));
        } else {
          resolve(parsed);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listAll(path, params = {}) {
  const results = [];
  let startingAfter = null;
  while (true) {
    const query = { ...params, limit: 100 };
    if (startingAfter) query.starting_after = startingAfter;
    const page = await stripeRequest('GET', `${path}?${new URLSearchParams(query)}`);
    results.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n  MCPEmails — Stripe product setup\n');

  // Verify the key works and tell us which mode we're in.
  const account = await stripeRequest('GET', '/account', null).catch((err) => {
    console.error('  ❌  Could not reach Stripe:', err.message);
    process.exit(1);
  });

  const mode = SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST';
  console.log(`  ✓  Connected to Stripe account: ${account.display_name ?? account.id} (${mode} mode)\n`);

  if (mode === 'LIVE') {
    console.warn(
      '  ⚠️   You are using a LIVE key. Products and prices created here will\n' +
      '      appear in your production Stripe account. Press Ctrl-C to abort.\n',
    );
  }

  // Fetch existing products so we can reuse them instead of creating duplicates.
  const existingProducts = await listAll('/products', { active: 'true' });

  const envUpdates = {}; // envVar → priceId

  for (const productDef of PRODUCTS) {
    // ── Find or create the product ─────────────────────────────────────────
    let product = existingProducts.find((p) => p.name === productDef.name);

    if (product) {
      console.log(`  ↩  Product already exists: ${productDef.name} (${product.id})`);
    } else {
      product = await stripeRequest('POST', '/products', {
        name: productDef.name,
        description: productDef.description,
      });
      console.log(`  ✓  Created product: ${productDef.name} (${product.id})`);
    }

    // ── Find or create each price ──────────────────────────────────────────
    const existingPrices = await listAll('/prices', { product: product.id, active: 'true' });

    for (const priceDef of productDef.prices) {
      const existingPrice = existingPrices.find(
        (p) =>
          p.unit_amount === priceDef.unit_amount &&
          p.currency === priceDef.currency &&
          p.recurring?.interval === priceDef.interval &&
          p.tax_behavior === 'exclusive',
      );

      let price;
      if (existingPrice) {
        price = existingPrice;
        const display = `$${(priceDef.unit_amount / 100).toFixed(2)}/${priceDef.interval}`;
        console.log(`  ↩  Price already exists: ${display} (${price.id})`);
      } else {
        price = await stripeRequest('POST', '/prices', {
          product: product.id,
          unit_amount: String(priceDef.unit_amount),
          currency: priceDef.currency,
          'recurring[interval]': priceDef.interval,
          // Immutable once set, so it is set now rather than after the first
          // tax registration forces a whole new price and a migration.
          tax_behavior: 'exclusive',
        });
        const display = `$${(priceDef.unit_amount / 100).toFixed(2)}/${priceDef.interval}`;
        console.log(`  ✓  Created price: ${display} (${price.id})`);
      }

      envUpdates[priceDef.envVar] = price.id;
    }
  }

  // ── Patch .env.local ──────────────────────────────────────────────────────
  console.log(`\n  Patching ${ENV_FILE} …\n`);

  let envContent = '';
  try {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    console.error(`  ❌  Could not read ${ENV_FILE}`);
    process.exit(1);
  }

  for (const [key, value] of Object.entries(envUpdates)) {
    // Replace existing line (with or without a value) or append if absent.
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
    console.log(`  ✓  ${key}=${value}`);
  }

  fs.writeFileSync(ENV_FILE, envContent, 'utf8');

  console.log('\n  ✅  Done! .env.local has been updated with the price IDs.\n');
  console.log('  Next steps:');
  console.log('  1. Add your real STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to .env.local');
  console.log('  2. Set up the Stripe webhook (see Documents/Human-Input/STRIPE_SETUP_NEEDED.md §5)');
  console.log('  3. Add all four STRIPE_PRICE_* vars to Vercel: https://vercel.com/dashboard');
  console.log('     (Pro = STRIPE_PRICE_SOLO_*, Team = STRIPE_PRICE_PRO_*)');
  console.log('  4. Restart your dev server.\n');
}

main().catch((err) => {
  console.error('\n  ❌  Unexpected error:', err.message);
  process.exit(1);
});
