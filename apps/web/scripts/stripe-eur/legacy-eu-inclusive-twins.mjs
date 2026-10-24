#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Create a USD tax-INCLUSIVE twin of every MCPEmails price that an EU
// subscriber is billed on, so the legacy swap (legacy-eu-inclusive-swap.mjs)
// can keep each EU subscriber's amount while Stripe Tax extracts the VAT from
// it (owner decision 2026-10-24: absorb VAT). Runbook: docs/RUNBOOK-eur-launch.md.
//
// A twin has the same product, currency, unit_amount and interval as its
// original, tax_behavior inclusive, nickname "<original> (incl. VAT)" and
// metadata twin_of=<original id>. An existing active twin is reused, so the
// script is idempotent.
//
// DRY-RUN BY DEFAULT; `--apply` creates; `--live` targets live mode.
// Writes the mapping { twinId: originalId } to --out (default
// ../../Documents/stripe/legacy-eu-twins.<mode>.json, gitignored: it is
// account data). That JSON, minified, is the STRIPE_PRICE_TWINS env value.
// A dry run maps "(new)" placeholders and is not a usable env value.
//
// Price ids: the same env vars / --prices file as eur-currency-options.mjs,
// plus every legacy id plans.ts lists.
// ---------------------------------------------------------------------------

import { resolve } from 'node:path';

import {
  EU_COUNTRIES,
  REPO_ROOT,
  isTwinOf,
  listAll,
  loadBillingSubscriptions,
  loadCatalogueIds,
  loadPriceEnv,
  makeStripe,
  modeLabel,
  parseArgs,
  twinCreateParams,
  writeAccountFile,
} from './lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: legacy-eu-inclusive-twins.mjs [--prices file.json] [--out mapping.json] [--live] [--apply]');
    return 0;
  }
  const stripe = makeStripe({ live: args.live });
  const mode = modeLabel(args.live);
  const out = args.out ?? resolve(REPO_ROOT, 'Documents', 'stripe', `legacy-eu-twins.${args.live ? 'live' : 'test'}.json`);
  console.log(`# Legacy EU inclusive twins, ${mode} mode, ${args.apply ? 'APPLY' : 'dry run'} (${stripe.transport})`);

  const catalogue = await loadCatalogueIds(loadPriceEnv(args.prices));
  const rows = await loadBillingSubscriptions(stripe, catalogue);

  const eu = rows.filter((r) => r.country && EU_COUNTRIES.has(r.country));
  const unknown = rows.filter((r) => !r.country).length;
  const subsByPrice = new Map();
  for (const { sub } of eu) {
    for (const it of sub.items?.data ?? []) {
      const id = it.price?.id;
      if (!id) continue;
      subsByPrice.set(id, (subsByPrice.get(id) ?? 0) + 1);
    }
  }
  console.log(`billing MCPEmails subscriptions: ${rows.length}; EU: ${eu.length}; country unknown: ${unknown}`);

  const mapping = {};
  const counts = { pricesWithEuSubs: subsByPrice.size, twinsExisting: 0, twinsToCreate: 0, created: 0, skippedForeignPrice: 0 };
  let failed = false;
  for (const [priceId, n] of subsByPrice) {
    const price = await stripe.request('GET', `/v1/prices/${priceId}`);
    const productId = typeof price.product === 'string' ? price.product : price.product.id;
    if (!catalogue.has(priceId)) {
      // An item outside the catalogue on an MCPEmails subscription (for
      // example a Dashboard-sold add-on with no env var). Twinned too, since
      // the swap needs every item covered; reported so it can be checked.
      counts.skippedForeignPrice++;
      console.log(`note: ${priceId} is not in plans.ts or the env set; twinning it anyway`);
    }
    if (price.tax_behavior === 'inclusive') {
      console.log(`${priceId}: already inclusive, ${n} EU subs, no twin needed`);
      continue;
    }
    const siblings = await listAll(stripe, '/v1/prices', { product: productId, active: 'true' });
    const twin = siblings.find((p) => isTwinOf(p, price));
    if (twin) {
      counts.twinsExisting++;
      mapping[twin.id] = priceId;
      console.log(`${priceId} (${price.unit_amount} ${price.currency}/${price.recurring?.interval}, ${n} EU subs): twin ${twin.id} exists`);
      continue;
    }
    counts.twinsToCreate++;
    const params = twinCreateParams(price);
    console.log(`${priceId} (${price.unit_amount} ${price.currency}/${price.recurring?.interval}, ${n} EU subs): ${args.apply ? 'CREATE' : 'would create'} twin "${params.nickname}"`);
    if (!args.apply) {
      mapping[`(new twin of ${priceId})`] = priceId;
      continue;
    }
    try {
      const created = await stripe.request('POST', '/v1/prices', params, { idempotencyKey: `eu-twin-${priceId}` });
      mapping[created.id] = priceId;
      counts.created++;
      console.log(`  created ${created.id}`);
    } catch (err) {
      failed = true;
      console.error(`  FAILED ${err.message}`);
    }
  }

  const written = writeAccountFile(out, mapping);
  console.log(`\nmapping written to ${written}`);
  if (args.apply && !failed) console.log(`STRIPE_PRICE_TWINS='${JSON.stringify(mapping)}'`);
  console.log(`SUMMARY ${JSON.stringify(counts)}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
