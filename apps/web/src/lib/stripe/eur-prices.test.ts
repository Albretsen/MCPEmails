import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EU_COUNTRIES,
  displayCurrencyFor,
  eurCentsFor,
  eurPricesEnabled,
  euroizeAmounts,
  formatMoneyCents,
  isEuCountry,
} from './eur-prices.ts';

test('the switch is off unless explicitly on', () => {
  for (const v of [undefined, '', 'false', 'off', '0', 'no', 'enabled', ' tru e']) {
    assert.equal(eurPricesEnabled({ STRIPE_EUR_PRICES: v }), false, String(v));
  }
  for (const v of ['true', 'on', '1', 'yes', ' TRUE ', 'Yes']) {
    assert.equal(eurPricesEnabled({ STRIPE_EUR_PRICES: v }), true, v);
  }
});

test('all 27 member states, nothing else', () => {
  assert.equal(EU_COUNTRIES.length, 27);
  assert.equal(new Set(EU_COUNTRIES).size, 27);
  for (const cc of ['SE', 'PL', 'CZ', 'DK', 'HU', 'RO', 'BG', 'de']) assert.ok(isEuCountry(cc), cc);
  for (const cc of ['NO', 'CH', 'GB', 'IS', 'US', 'EL', null, undefined, '']) assert.equal(isEuCountry(cc), false, String(cc));
});

test('EUR needs both the switch and an EU country', () => {
  assert.equal(displayCurrencyFor({ eurEnabled: true, country: 'DE' }), 'eur');
  assert.equal(displayCurrencyFor({ eurEnabled: false, country: 'DE' }), 'usd');
  assert.equal(displayCurrencyFor({ eurEnabled: true, country: 'US' }), 'usd');
  assert.equal(displayCurrencyFor({ eurEnabled: true, country: null }), 'usd');
});

test('the EUR amount is the Stripe option, else the same digits as USD', () => {
  assert.equal(eurCentsFor(900, 900), 900);
  assert.equal(eurCentsFor(null, 1900), 1900);
  assert.equal(eurCentsFor(0, 8640), 8640);
  assert.equal(eurCentsFor(undefined, null), null);
});

test('money is formatted the way each locale writes it', () => {
  const nbsp = (s: string) => s.replace(/[  ]/g, ' ');
  assert.equal(formatMoneyCents(900, 'eur', 'en'), '€9');
  assert.equal(formatMoneyCents(8640, 'eur', 'en'), '€86.40');
  assert.equal(nbsp(formatMoneyCents(900, 'eur', 'de')), '9 €');
  assert.equal(nbsp(formatMoneyCents(8640, 'eur', 'fr')), '86,40 €');
  assert.equal(nbsp(formatMoneyCents(37440, 'eur', 'es')), '374,40 €');
  assert.equal(formatMoneyCents(900, 'usd', 'en-US'), '$9');
});

test('euroizing changes the sign and format, never a number', () => {
  const nbsp = (s: string) => s.replace(/[  ]/g, ' ');
  assert.equal(euroizeAmounts('Three inboxes, $9.', 'en'), 'Three inboxes, €9.');
  assert.equal(euroizeAmounts('Billed $86.40/year', 'en'), 'Billed €86.40/year');
  assert.equal(nbsp(euroizeAmounts('Facturé 86,40 $/an', 'fr')), 'Facturé 86,40 €/an');
  assert.equal(nbsp(euroizeAmounts('Drei Postfächer, $9.', 'de')), 'Drei Postfächer, 9 €.');
  assert.equal(euroizeAmounts('每月 $9 连接', 'zh'), '每月 €9 连接');
  assert.equal(euroizeAmounts('1,000 requests a minute, 10 mailboxes', 'en'), '1,000 requests a minute, 10 mailboxes');
});

test('the client-side module uses no lookbehind (Safari before 16.4 cannot parse one)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./eur-prices.ts', import.meta.url), 'utf8');
  assert.ok(!/\(\?<[=!]/.test(source), 'eur-prices.ts must not contain a lookbehind');
});
