import test from 'node:test';
import assert from 'node:assert/strict';
import { chargesInUsd, monthOf, toUsdMinor, usdPerUnit } from './fx.ts';
import { USD_PER_UNIT_BY_MONTH } from './fx-rates.ts';
import { FX_CURRENCIES, monthlyAverages, renderModule } from '../../../scripts/fx-rates-refresh.mjs';

const MONTHS = Object.keys(USD_PER_UNIT_BY_MONTH).sort();
const FIRST = MONTHS[0];
const LATEST = MONTHS[MONTHS.length - 1];

test('USD passes through untouched, so a USD-only account reads exactly as before', () => {
  assert.equal(usdPerUnit('usd', '2026-05'), 1);
  assert.equal(usdPerUnit('USD', '1999-01'), 1);
  assert.equal(toUsdMinor(2900, 'usd', '2026-05'), 2900);
  assert.equal(toUsdMinor(359.25, 'usd', '2030-01'), 359.25);
});

test('every currency the table promises has a sane rate in every month', () => {
  for (const month of MONTHS) {
    for (const code of ['eur', 'gbp', 'nok', 'chf', 'sek', 'dkk', 'pln', 'czk']) {
      const rate = USD_PER_UNIT_BY_MONTH[month][code];
      assert.ok(Number.isFinite(rate) && rate > 0.01 && rate < 5, `${code} ${month}: ${rate}`);
    }
  }
  // The euro has been worth more than a dollar all year; a flipped table
  // (EUR per USD) would fail here.
  assert.ok((usdPerUnit('eur', LATEST) ?? 0) > 1);
});

test('later months use the latest rate, earlier ones the first', () => {
  assert.equal(usdPerUnit('eur', '2099-12'), USD_PER_UNIT_BY_MONTH[LATEST].eur);
  assert.equal(usdPerUnit('eur', '2020-01'), USD_PER_UNIT_BY_MONTH[FIRST].eur);
  assert.equal(usdPerUnit('EUR', FIRST), USD_PER_UNIT_BY_MONTH[FIRST].eur);
});

test('an unknown currency is null, never zero', () => {
  assert.equal(usdPerUnit('xts', LATEST), null);
  assert.equal(toUsdMinor(1000, 'xts', LATEST), null);
});

test('monthOf is the UTC month', () => {
  assert.equal(monthOf(Date.UTC(2026, 9, 31, 23, 59) / 1000), '2026-10');
  assert.equal(monthOf(Date.UTC(2026, 10, 1, 0, 0) / 1000), '2026-11');
});

test('cash converts each charge at the month it landed in, and names what it cannot', () => {
  const march = Date.UTC(2026, 2, 10) / 1000;
  const june = Date.UTC(2026, 5, 10) / 1000;
  const { rows, otherCurrencies } = chargesInUsd([
    { amount: 1500, amount_refunded: 0, currency: 'usd', created: march },
    { amount: 1000, amount_refunded: 1000, currency: 'eur', created: march },
    { amount: 1000, amount_refunded: null, currency: 'eur', created: june },
    { amount: 700, amount_refunded: 0, currency: 'xts', created: june },
  ]);
  assert.deepEqual(rows, [
    { grossMinor: 1500, refundedMinor: 0, at: '2026-03-10T00:00:00.000Z' },
    {
      grossMinor: Math.round(1000 * USD_PER_UNIT_BY_MONTH['2026-03'].eur),
      refundedMinor: Math.round(1000 * USD_PER_UNIT_BY_MONTH['2026-03'].eur),
      at: '2026-03-10T00:00:00.000Z',
    },
    { grossMinor: Math.round(1000 * USD_PER_UNIT_BY_MONTH['2026-06'].eur), refundedMinor: 0, at: '2026-06-10T00:00:00.000Z' },
  ]);
  assert.deepEqual(otherCurrencies, ['xts']);
});

test('the refresh script averages the daily USD cross rate per month', () => {
  const series = {
    base: 'EUR',
    rates: {
      // A range opening on a holiday starts with the business day before it.
      '2025-12-31': { USD: 9, NOK: 9 },
      '2026-01-02': { USD: 1.2, NOK: 12, GBP: 0.8 },
      '2026-01-05': { USD: 1.1, NOK: 11, GBP: 0.8 },
      '2026-02-02': { USD: 1.0, NOK: 10 },
    },
  };
  const table = monthlyAverages(series, ['EUR', 'NOK', 'GBP'], { from: '2026-01-01' });
  assert.deepEqual(Object.keys(table), ['2026-01', '2026-02']);
  assert.equal(table['2026-01'].eur, 1.15);
  assert.equal(table['2026-01'].nok, 0.1);
  assert.equal(table['2026-01'].gbp, 1.4375);
  assert.deepEqual(table['2026-02'], { eur: 1, nok: 0.1 });
  assert.ok(FX_CURRENCIES.includes('EUR'));
  const source = renderModule(table, { from: '2026-01-01', to: '2026-02-02' });
  assert.match(source, /'2026-01': \{ eur: 1\.15, nok: 0\.1, gbp: 1\.4375 \},/);
  assert.throws(() => monthlyAverages({ base: 'USD', rates: {} }));
});
