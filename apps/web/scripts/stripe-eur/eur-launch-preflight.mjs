#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The EUR launch preflight, by hand and READ-ONLY: the exact checks the
// dispatcher (app/api/internal/eur-launch/dispatch) runs before it turns the
// launch on, against the Stripe account of your choice. Runbook:
// docs/RUNBOOK-eur-launch.md.
//
// NEVER WRITES. There is no --apply: this only GETs (registrations, webhook
// endpoints, payment method configurations, prices) and prints one line per
// check. Use it ahead of 2026-12-07 to see what would still keep the launch
// off, and after a fix to confirm it.
//
//   cd apps/web
//   node scripts/stripe-eur/eur-launch-preflight.mjs --prices ../../Documents/stripe/prices.live.json --live
//
// Transport and price ids as the other scripts here (lib.mjs): STRIPE_SECRET_KEY
// or the Stripe CLI, ids from the env or a --prices file. STRIPE_PMC_ID is read
// from the environment, as the dispatcher reads it.
// Exit code 0 when every check passes, 1 when one fails.
// ---------------------------------------------------------------------------

import { loadPriceEnv, makeStripe, modeLabel, parseArgs } from './lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: eur-launch-preflight.mjs [--prices file.json] [--live]');
    return 0;
  }
  if (args.apply) {
    console.error('This script is read-only; --apply is not accepted.');
    return 2;
  }
  const stripe = makeStripe({ live: args.live });
  const ids = loadPriceEnv(args.prices);
  // Set before the run module loads: plans.ts reads its ids at import.
  for (const [k, v] of Object.entries(ids)) process.env[k] = v;
  const { runPreflight } = await import('../../src/lib/stripe/eur-launch-run.ts');

  console.log(`# EUR launch preflight, ${modeLabel(args.live)} mode, read-only (${stripe.transport})`);
  const result = await runPreflight({ stripe, env: process.env });
  for (const c of result.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.code}: ${c.detail}`);
    if (!c.ok) console.log(`     fix: ${c.fix}`);
  }
  const updates = result.pricePlans.filter((p) => p.params).map((p) => p.env);
  console.log(`\nprices that would get an EUR option at launch: ${updates.length ? updates.join(', ') : 'none'}`);
  console.log(`RESULT ${result.ok ? 'every check passes' : `${result.checks.filter((c) => !c.ok).length} failing`}`);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
