// ---------------------------------------------------------------------------
// The EUR launch state (eur-launch.ts): when checkout and the pricing pages
// treat EUR prices and Stripe Tax as on.
//
//   off before 2026-12-07 Oslo, whatever the flag says, and with no read
//   live after it only with the flag true
//   the env switches still turn things on by hand, on any date
//   STRIPE_FORCE_USD beats everything
//   a failed read is off, and is retried rather than cached
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/eur-launch.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EUR_LAUNCH_AT,
  EUR_LAUNCH_FLAG_KEY,
  effectiveStripeEnv,
  eurDisplayEnabled,
  eurLaunchState,
  eurLaunchStateFor,
  readEurLaunchFlag,
  resetEurLaunchCache,
} from './eur-launch.ts';
import { eurLaunchDatePassed } from './eur-launch-date.ts';
import { checkoutCurrencyFor } from './currency.ts';
import { automaticTaxEnabled, checkoutTaxParams } from './tax-switch.ts';

const BEFORE = Date.parse('2026-12-06T22:59:59.999Z');
const AT = Date.parse('2026-12-06T23:00:00.000Z');
const AFTER = Date.parse('2026-12-07T09:00:00.000Z');

/** A pricing_switches stand-in: `.from().select().eq().maybeSingle()`. */
function fakeDb(value: boolean | null | 'error' | 'throw') {
  let reads = 0;
  const db = {
    from(table: string) {
      assert.equal(table, 'pricing_switches');
      return {
        select() {
          return {
            eq(column: string, key: string) {
              assert.equal(column, 'key');
              assert.equal(key, EUR_LAUNCH_FLAG_KEY);
              return {
                async maybeSingle() {
                  reads++;
                  if (value === 'throw') throw new Error('network down');
                  if (value === 'error') return { data: null, error: { message: 'boom' } };
                  return { data: value === null ? null : { enabled: value }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: db as never, reads: () => reads };
}

test('the launch instant is 2026-12-07 00:00 in Oslo', () => {
  assert.equal(EUR_LAUNCH_AT, '2026-12-06T23:00:00.000Z');
  assert.equal(eurLaunchDatePassed(BEFORE), false);
  assert.equal(eurLaunchDatePassed(AT), true);
});

test('the pure rule: live needs both the date and the flag', () => {
  assert.equal(eurLaunchStateFor({ now: BEFORE, flag: true }), 'off');
  assert.equal(eurLaunchStateFor({ now: AFTER, flag: false }), 'off');
  assert.equal(eurLaunchStateFor({ now: AFTER, flag: null }), 'off');
  assert.equal(eurLaunchStateFor({ now: AFTER, flag: true }), 'live');
});

test('before the date: off, and the database is never read, even with the flag set', async () => {
  resetEurLaunchCache();
  const { db, reads } = fakeDb(true);
  assert.equal(await eurLaunchState({ db, now: BEFORE }), 'off');
  const env = await effectiveStripeEnv({ db, now: BEFORE, env: {} });
  assert.deepEqual(env, {});
  assert.equal(reads(), 0);
});

test('after the date: live with the flag, off without it or with no row', async () => {
  for (const [flag, want] of [[true, 'live'], [false, 'off'], [null, 'off']] as const) {
    resetEurLaunchCache();
    assert.equal(await eurLaunchState({ db: fakeDb(flag).db, now: AFTER }), want, String(flag));
  }
});

test('live turns EUR and Stripe Tax on for checkout without any env switch', async () => {
  resetEurLaunchCache();
  const env = await effectiveStripeEnv({ db: fakeDb(true).db, now: AFTER, env: {} });
  assert.equal(automaticTaxEnabled(env), true);
  assert.equal(checkoutCurrencyFor('SE', env), 'eur');
  assert.equal(checkoutCurrencyFor('DE', env), undefined, 'euro area is localized by Stripe');
  assert.ok('automatic_tax' in checkoutTaxParams(env));
  resetEurLaunchCache();
  assert.equal(await eurDisplayEnabled({ db: fakeDb(true).db, now: AFTER, env: {} }), true);
});

test('off leaves the env exactly as it was', async () => {
  resetEurLaunchCache();
  const source = { STRIPE_PMC_ID: 'pmc_x' };
  const env = await effectiveStripeEnv({ db: fakeDb(false).db, now: AFTER, env: source });
  assert.equal(env, source);
  assert.equal(automaticTaxEnabled(env), false);
  assert.equal(checkoutCurrencyFor('SE', env), undefined);
});

test('the env switches are a manual override on any date, with no read', async () => {
  resetEurLaunchCache();
  const { db, reads } = fakeDb(false);
  const source = { STRIPE_EUR_PRICES: 'true', STRIPE_AUTOMATIC_TAX: 'true' };
  const env = await effectiveStripeEnv({ db, now: BEFORE, env: source });
  assert.equal(automaticTaxEnabled(env), true);
  assert.equal(checkoutCurrencyFor('PL', env), 'eur');
  assert.equal(await eurDisplayEnabled({ db, now: BEFORE, env: { STRIPE_EUR_PRICES: 'yes' } }), true);
  assert.equal(reads(), 0);
});

test('STRIPE_FORCE_USD beats the launch flag and the env switches', async () => {
  resetEurLaunchCache();
  const { db, reads } = fakeDb(true);
  const source = { STRIPE_FORCE_USD: 'true', STRIPE_EUR_PRICES: 'true', STRIPE_AUTOMATIC_TAX: 'true' };
  const env = await effectiveStripeEnv({ db, now: AFTER, env: source });
  assert.equal(checkoutCurrencyFor('SE', env), 'usd');
  assert.equal(checkoutCurrencyFor('DE', env), 'usd');
  assert.equal(await eurDisplayEnabled({ db, now: AFTER, env: source }), false);
  assert.equal(await eurDisplayEnabled({ db, now: AFTER, env: { STRIPE_FORCE_USD: '1' } }), false);
  assert.equal(reads(), 0, 'under the rollback nothing is read');
});

test('a failed read is off, and is retried on the next call rather than cached', async () => {
  for (const failure of ['error', 'throw'] as const) {
    resetEurLaunchCache();
    const { db, reads } = fakeDb(failure);
    assert.equal(await eurLaunchState({ db, now: AFTER }), 'off');
    assert.equal(await eurLaunchState({ db, now: AFTER + 1 }), 'off');
    assert.equal(reads(), 2, failure);
  }
});

test('a good read is cached for 60 s, then read again', async () => {
  resetEurLaunchCache();
  const { db, reads } = fakeDb(true);
  assert.equal(await readEurLaunchFlag({ db, now: AFTER }), true);
  assert.equal(await readEurLaunchFlag({ db, now: AFTER + 59_000 }), true);
  assert.equal(reads(), 1);
  assert.equal(await readEurLaunchFlag({ db, now: AFTER + 61_000 }), true);
  assert.equal(reads(), 2);
  assert.equal(await readEurLaunchFlag({ db, now: AFTER + 62_000, fresh: true }), true);
  assert.equal(reads(), 3);
});

test('the dispatcher can prime the cache right after it writes the flag', async () => {
  resetEurLaunchCache(true, AFTER);
  const { db, reads } = fakeDb(false);
  assert.equal(await eurLaunchState({ db, now: AFTER + 1_000 }), 'live');
  assert.equal(reads(), 0);
  resetEurLaunchCache();
});
