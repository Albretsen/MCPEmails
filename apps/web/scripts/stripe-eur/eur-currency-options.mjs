#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Add the EUR currency option (VAT-inclusive, same digits as USD) to every
// sold MCPEmails price, set tax_behavior=exclusive on sold USD prices that are
// still `unspecified`, and set tax_code on MCPEmails products that have none.
// Runbook: docs/RUNBOOK-eur-launch.md.
//
// DRY-RUN BY DEFAULT. `--apply` writes. `--live` targets live mode (without
// it the run is test mode). Idempotent: a price that already has the right
// EUR option, or a product that already has a tax code, is skipped.
//
// ONE WAY. Stripe cannot remove or change a currency option once added
// (checked in test mode 2026-10-24). Adding EUR switches EU visitors to EUR
// in Checkout at once, so run --apply --live only in the launch window, after
// the code is deployed.
//
// Price ids come from the env vars in lib.mjs SOLD_PRICE_ENV (the names
// plans.ts and the mailbox add-on read, plus STRIPE_PRICE_JAPAN_ROUTE_YEARLY),
// or from `--prices file.json` ({ "ENV_NAME": "price_..." }).
//
//   cd apps/web
//   node scripts/stripe-eur/eur-currency-options.mjs --prices ../../Documents/stripe/prices.live.json --live
//   node scripts/stripe-eur/eur-currency-options.mjs --prices ../../Documents/stripe/prices.live.json --live --apply
// ---------------------------------------------------------------------------

import {
  SOLD_PRICE_ENV,
  loadCatalogueIds,
  loadPriceEnv,
  makeStripe,
  modeLabel,
  parseArgs,
  planPriceUpdate,
  planProductUpdate,
} from './lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: eur-currency-options.mjs [--prices file.json] [--live] [--apply]');
    return 0;
  }
  const stripe = makeStripe({ live: args.live });
  const ids = loadPriceEnv(args.prices);
  console.log(`# EUR currency options, ${modeLabel(args.live)} mode, ${args.apply ? 'APPLY' : 'dry run'} (${stripe.transport})`);

  let failed = false;
  const missing = SOLD_PRICE_ENV.filter((s) => !ids[s.env] && !s.optional).map((s) => s.env);
  if (missing.length) {
    console.error(`missing required price ids: ${missing.join(', ')}`);
    failed = true;
  }

  const counts = { pricesChecked: 0, pricesToUpdate: 0, eurToAdd: 0, taxBehaviorToSet: 0, pricesWithProblems: 0, productsToTag: 0 };
  const productIds = new Set();

  for (const spec of SOLD_PRICE_ENV) {
    const id = ids[spec.env];
    if (!id) continue;
    counts.pricesChecked++;
    const price = await stripe.request('GET', `/v1/prices/${id}`, { expand: ['currency_options'] });
    productIds.add(typeof price.product === 'string' ? price.product : price.product.id);
    const eur = price.currency_options?.eur;
    console.log(
      `${spec.env} ${id}: ${price.currency} ${price.unit_amount} ${price.tax_behavior}` +
        ` | eur ${eur ? `${eur.unit_amount} ${eur.tax_behavior}` : 'none'}`,
    );
    const { problems, params } = planPriceUpdate(price, spec);
    for (const p of problems) console.log(`  PROBLEM ${p}`);
    if (problems.length) counts.pricesWithProblems++;
    if (!params) {
      if (!problems.length) console.log('  ok, nothing to do');
      continue;
    }
    counts.pricesToUpdate++;
    if (params.tax_behavior) counts.taxBehaviorToSet++;
    if (params['currency_options[eur][unit_amount]']) counts.eurToAdd++;
    console.log(`  ${args.apply ? 'UPDATE' : 'would update'} ${JSON.stringify(params)}`);
    if (args.apply) {
      try {
        await stripe.request('POST', `/v1/prices/${id}`, params, { idempotencyKey: `eur-opt-${id}-${Object.keys(params).join('-')}` });
        console.log('  done');
      } catch (err) {
        failed = true;
        console.error(`  FAILED ${err.message}`);
      }
    }
  }

  // Products: every product behind a sold or legacy MCPEmails price, because
  // legacy subscriptions get automatic tax too after the inclusive-twin swap.
  const catalogue = await loadCatalogueIds(ids);
  for (const id of catalogue) {
    try {
      const price = await stripe.request('GET', `/v1/prices/${id}`);
      productIds.add(typeof price.product === 'string' ? price.product : price.product.id);
    } catch (err) {
      console.log(`legacy price ${id} not readable in this mode: ${err.message}`);
    }
  }
  for (const productId of productIds) {
    const product = await stripe.request('GET', `/v1/products/${productId}`);
    const params = planProductUpdate(product);
    if (!params) {
      console.log(`product ${productId}: tax_code ${product.tax_code}, ok`);
      continue;
    }
    counts.productsToTag++;
    console.log(`product ${productId}: no tax_code, ${args.apply ? 'UPDATE' : 'would set'} ${params.tax_code}`);
    if (args.apply) {
      try {
        await stripe.request('POST', `/v1/products/${productId}`, params);
        console.log('  done');
      } catch (err) {
        failed = true;
        console.error(`  FAILED ${err.message}`);
      }
    }
  }

  console.log(`\nSUMMARY ${JSON.stringify(counts)}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
