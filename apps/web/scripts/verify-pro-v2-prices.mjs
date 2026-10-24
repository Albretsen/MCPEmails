#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Check the Stripe prices behind STRIPE_PRICE_SOLO_MONTHLY_V2 / _YEARLY_V2
// before the Pro price cutover (src/lib/stripe/pro-price-change.ts).
//
// WHY. getPrices.ts falls back to the catalogue cents when a price cannot be
// read, so a wrong id in an env var can show $19 on the page while checkout
// charges whatever that id really is. The Personal reprice once created an
// $86.40-a-MONTH price by mistake. This reads both ids from Stripe and exits
// non-zero unless each one is exactly what the catalogue will sell.
//
// Run with the LIVE key and the ids you are about to put in Vercel:
//
//   STRIPE_SECRET_KEY=rk_live_... \
//   STRIPE_PRICE_SOLO_MONTHLY_V2=price_... \
//   STRIPE_PRICE_SOLO_YEARLY_V2=price_... \
//   STRIPE_PRICE_SOLO_MONTHLY=price_... \
//   node scripts/verify-pro-v2-prices.mjs
//
// STRIPE_PRICE_SOLO_MONTHLY is optional; when set, the new prices must sit on
// the same product as the current Pro price. Read-only: it never writes.
// ---------------------------------------------------------------------------

import { PRO_PRICE_CHANGE } from '../src/lib/stripe/pro-price-change.ts';

/** What one price must look like. Pure, so the test can run it on fixtures. */
export function checkPrice(price, { cents, interval, product }) {
  const problems = [];
  if (!price || price.object !== 'price') return ['not a Stripe price'];
  if (price.active !== true) problems.push('not active');
  if (price.currency !== 'usd') problems.push(`currency ${price.currency}, expected usd`);
  if (price.unit_amount !== cents) problems.push(`unit_amount ${price.unit_amount}, expected ${cents}`);
  if (price.type !== 'recurring' || price.recurring?.interval !== interval) {
    problems.push(`interval ${price.recurring?.interval ?? price.type}, expected ${interval}`);
  }
  if ((price.recurring?.interval_count ?? 1) !== 1) problems.push('interval_count is not 1');
  if (price.recurring?.usage_type && price.recurring.usage_type !== 'licensed') {
    problems.push(`usage_type ${price.recurring.usage_type}, expected licensed`);
  }
  // Every live Pro price is tax-exclusive; a new one must match or the
  // customer-facing total changes with no copy to explain it.
  if (price.tax_behavior !== 'exclusive') problems.push(`tax_behavior ${price.tax_behavior}, expected exclusive`);
  const priceProduct = typeof price.product === 'string' ? price.product : price.product?.id;
  if (product && priceProduct !== product) problems.push(`product ${priceProduct}, expected ${product}`);
  return problems;
}

async function retrieve(id, key) {
  const res = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${id}: ${body?.error?.message ?? res.status}`);
  return body;
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  const monthly = process.env.STRIPE_PRICE_SOLO_MONTHLY_V2?.trim();
  const yearly = process.env.STRIPE_PRICE_SOLO_YEARLY_V2?.trim();
  const current = process.env.STRIPE_PRICE_SOLO_MONTHLY?.trim();
  if (!key || !monthly || !yearly) {
    console.error('Set STRIPE_SECRET_KEY, STRIPE_PRICE_SOLO_MONTHLY_V2 and STRIPE_PRICE_SOLO_YEARLY_V2.');
    process.exit(2);
  }
  if (!key.includes('_live_')) console.warn('Warning: this is not a live key.');

  const product = current ? (await retrieve(current, key)).product : null;
  let failed = false;
  for (const [label, id, cents, interval] of [
    ['monthly', monthly, PRO_PRICE_CHANGE.next.monthlyCents, 'month'],
    ['yearly', yearly, PRO_PRICE_CHANGE.next.yearlyCents, 'year'],
  ]) {
    const problems = checkPrice(await retrieve(id, key), { cents, interval, product });
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${label} ${id}: ${problems.join('; ')}`);
    } else {
      console.log(`ok   ${label} ${id}: ${cents} usd per ${interval}`);
    }
  }
  if (monthly === yearly) {
    failed = true;
    console.error('FAIL the monthly and yearly ids are the same price');
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
