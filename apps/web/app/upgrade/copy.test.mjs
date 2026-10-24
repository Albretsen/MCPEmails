// Copy for /upgrade/done and /upgrade/expired (app/upgrade/copy.mjs): every
// locale has every string, and none of them breaks a house rule.
// Run: npm run test:checkout-link
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPGRADE_COPY, UPGRADE_LOCALES, upgradeCopy, upgradeLocale, pricingPath } from './copy.mjs';

test('every locale carries exactly the English keys, none empty', () => {
  const keys = Object.keys(UPGRADE_COPY.en).sort();
  assert.deepEqual(Object.keys(UPGRADE_COPY).sort(), [...UPGRADE_LOCALES].sort());
  for (const locale of UPGRADE_LOCALES) {
    assert.deepEqual(Object.keys(UPGRADE_COPY[locale]).sort(), keys, locale);
    for (const key of keys) assert.ok(UPGRADE_COPY[locale][key].trim().length > 0, `${locale}.${key}`);
  }
});

test('no em dashes, no angle brackets, no curly quotes, no "30 days", no price', () => {
  for (const locale of UPGRADE_LOCALES) {
    for (const [key, value] of Object.entries(UPGRADE_COPY[locale])) {
      const where = `${locale}.${key}`;
      assert.doesNotMatch(value, /—/, where);
      assert.doesNotMatch(value, /[<>]/, where);
      assert.doesNotMatch(value, /[‘’“”]/, where);
      assert.doesNotMatch(value, /30 (days|dager|días|jours|Tage)/i, where);
      assert.doesNotMatch(value, /[$€]|\bUSD\b/, where);
    }
  }
});

test('the reader\'s language comes from Accept-Language, in header order, English otherwise', () => {
  assert.equal(upgradeLocale('nb-NO,nb;q=0.9,en;q=0.8'), 'nb');
  assert.equal(upgradeLocale('no'), 'nb');
  assert.equal(upgradeLocale('fr-CA, en;q=0.5'), 'fr');
  assert.equal(upgradeLocale('en-GB,de;q=0.9'), 'en');
  assert.equal(upgradeLocale('it-IT,de;q=0.7'), 'de');
  assert.equal(upgradeLocale('it-IT'), 'en');
  assert.equal(upgradeLocale(null), 'en');
  assert.equal(upgradeCopy('xx'), UPGRADE_COPY.en);
  assert.equal(pricingPath('en'), '/pricing');
  assert.equal(pricingPath('de'), '/de/pricing');
});
