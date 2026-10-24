#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Move every billing EU subscription onto the USD inclusive twins made by
// legacy-eu-inclusive-twins.mjs, with proration_behavior=none, and turn on
// automatic_tax for it. The subscriber keeps paying the same amount; Stripe
// Tax extracts the VAT from it. Runbook: docs/RUNBOOK-eur-launch.md.
//
// GUARDS
//   - Refuses --apply while the account has zero active Stripe Tax
//     registrations, and skips any subscription whose country no registration
//     covers (a non-Union OSS registration covers all 27).
//   - Skips a subscription whose customer Stripe Tax cannot locate
//     (customer.tax.automatic_tax not `supported`): turning automatic_tax on
//     for it would fail.
//   - Skips a subscription with a schedule, or with any item that has no twin
//     (never half-swapped).
//   - The STRIPE_PRICE_TWINS env with the same mapping must be live in the web
//     app BEFORE --apply, or the webhook cannot resolve the twin prices.
//
// DRY-RUN BY DEFAULT. Prints counts only, never names, emails or ids of
// customers. `--apply --live` executes in live mode.
//
//   node scripts/stripe-eur/legacy-eu-inclusive-swap.mjs --twins ../../Documents/stripe/legacy-eu-twins.live.json --prices ... --live
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  EU_COUNTRIES,
  REPO_ROOT,
  coveredCountries,
  listAll,
  loadBillingSubscriptions,
  loadCatalogueIds,
  loadPriceEnv,
  makeStripe,
  modeLabel,
  parseArgs,
  planSwap,
} from './lib.mjs';

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: legacy-eu-inclusive-swap.mjs [--twins mapping.json] [--prices file.json] [--live] [--apply]');
    return 0;
  }
  const stripe = makeStripe({ live: args.live });
  console.log(`# Legacy EU inclusive swap, ${modeLabel(args.live)} mode, ${args.apply ? 'APPLY' : 'dry run'} (${stripe.transport})`);

  const twinsFile = args.twins ?? resolve(REPO_ROOT, 'Documents', 'stripe', `legacy-eu-twins.${args.live ? 'live' : 'test'}.json`);
  const mapping = JSON.parse(readFileSync(twinsFile, 'utf8'));
  const placeholders = Object.keys(mapping).filter((k) => !k.startsWith('price_'));
  if (placeholders.length && args.apply) {
    console.error('The twin mapping is from a dry run (placeholder ids). Run the twins script with --apply first.');
    return 2;
  }
  const originalByTwin = new Map(Object.entries(mapping));
  const twinByOriginal = new Map(Object.entries(mapping).map(([twin, original]) => [original, twin]));

  const registrations = await listAll(stripe, '/v1/tax/registrations', { status: 'active' });
  const covered = coveredCountries(registrations);
  console.log(`active Stripe Tax registrations: ${registrations.length}`);
  if (registrations.length === 0) {
    if (args.apply) {
      console.error('Refusing to apply: no active Stripe Tax registrations. Add oss_non_union first (runbook step 3).');
      return 2;
    }
    console.log('WARNING: no registrations yet; counting as if every EU country were covered.');
    for (const c of EU_COUNTRIES) covered.add(c);
  }

  const catalogue = await loadCatalogueIds(loadPriceEnv(args.prices));
  const rows = await loadBillingSubscriptions(stripe, catalogue, originalByTwin);

  const counts = { billingSubs: rows.length, eu: 0, toSwap: 0, swapped: 0, failed: 0 };
  const skipped = {};
  const countrySource = {};
  const taxStatus = {};
  for (const { sub, customer, country, source } of rows) {
    if (!country || !EU_COUNTRIES.has(country)) continue;
    counts.eu++;
    bump(countrySource, source);
    if (!covered.has(country)) {
      bump(skipped, 'country_not_registered');
      continue;
    }
    const automaticTax = customer?.tax?.automatic_tax ?? 'unknown';
    bump(taxStatus, automaticTax);
    if (registrations.length > 0 && automaticTax !== 'supported') {
      bump(skipped, `tax_location_${automaticTax}`);
      continue;
    }
    const plan = planSwap(sub, { twinByOriginal, originalByTwin, catalogue });
    if (plan.action === 'skip') {
      bump(skipped, plan.reason);
      continue;
    }
    counts.toSwap++;
    if (!args.apply) continue;
    const params = { proration_behavior: 'none', 'automatic_tax[enabled]': 'true' };
    plan.items.forEach((it, i) => {
      params[`items[${i}][id]`] = it.id;
      params[`items[${i}][price]`] = it.price;
    });
    try {
      await stripe.request('POST', `/v1/subscriptions/${sub.id}`, params, {
        idempotencyKey: `eu-swap-${sub.id}-${plan.items.map((it) => it.price).join('-')}`,
      });
      counts.swapped++;
    } catch (err) {
      counts.failed++;
      console.error(`  a swap failed: ${err.message.replace(/sub_[A-Za-z0-9]+|cus_[A-Za-z0-9]+/g, '<id>')}`);
    }
  }

  console.log(`country source (EU subs): ${JSON.stringify(countrySource)}`);
  console.log(`Stripe Tax customer location status (EU subs, covered): ${JSON.stringify(taxStatus)}`);
  console.log(`skipped: ${JSON.stringify(skipped)}`);
  console.log(`SUMMARY ${JSON.stringify(counts)}`);
  return counts.failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message.replace(/sub_[A-Za-z0-9]+|cus_[A-Za-z0-9]+/g, '<id>'));
    process.exit(1);
  },
);
