import assert from 'node:assert/strict';
import test from 'node:test';
import { isEuropeanCountry, portalConfigurationFor } from './portal-configuration.ts';

const env = { STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_base', STRIPE_PORTAL_CONFIGURATION_ID_CANCEL_REASON: 'bpc_reason' };

test('known non-European countries get the reason configuration', () => {
  assert.equal(portalConfigurationFor({ requestCountry: 'US', signupCountry: 'US' }, env), 'bpc_reason');
  assert.equal(portalConfigurationFor({ requestCountry: 'br', signupCountry: null }, env), 'bpc_reason');
});

test('the EU, the rest of the EEA, Switzerland and the UK keep the base configuration', () => {
  for (const c of ['DE', 'FR', 'SE', 'NO', 'IS', 'LI', 'CH', 'GB']) {
    assert.equal(portalConfigurationFor({ requestCountry: c, signupCountry: null }, env), 'bpc_base', c);
    assert.equal(isEuropeanCountry(c), true, c);
  }
});

test('a European signup country wins over a non-European request', () => {
  assert.equal(portalConfigurationFor({ requestCountry: 'US', signupCountry: 'DE' }, env), 'bpc_base');
});

test('unknown or placeholder request countries fall back to the base configuration', () => {
  for (const c of [null, undefined, '', 'XX', 'EU', 'ZZ', 'not a code']) {
    assert.equal(portalConfigurationFor({ requestCountry: c, signupCountry: 'US' }, env), 'bpc_base', String(c));
  }
});

test('without the reason configuration set, everyone gets the base one', () => {
  assert.equal(
    portalConfigurationFor({ requestCountry: 'US', signupCountry: 'US' }, { STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_base' }),
    'bpc_base',
  );
  assert.equal(portalConfigurationFor({ requestCountry: 'US', signupCountry: 'US' }, {}), undefined);
});
