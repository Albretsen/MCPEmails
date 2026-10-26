import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkoutReassurance,
  reassuranceLocale,
  REASSURANCE_KINDS,
  REASSURANCE_LOCALES,
} from './checkout-reassurance.mjs';

test('the English lines say the three facts', () => {
  assert.equal(checkoutReassurance('en'), 'Charged today. Cancel any time. 14-day refund.');
  assert.equal(checkoutReassurance('en', 'subscription'), 'Charged today. Cancel any time. 14-day refund.');
  assert.equal(checkoutReassurance('en', 'pass'), 'Charged once today. Nothing to cancel. 14-day refund.');
  assert.equal(checkoutReassurance('en', 'deferred'), 'No charge today. Cancel any time. 14-day refund.');
});

test('every locale has every kind, distinct from English except en itself, and states 14 days', () => {
  for (const locale of REASSURANCE_LOCALES) {
    for (const kind of REASSURANCE_KINDS) {
      const line = checkoutReassurance(locale, kind);
      assert.ok(line.length > 10, `${locale}/${kind}`);
      assert.match(line, /14/, `${locale}/${kind} names the 14-day window`);
      assert.doesNotMatch(line, /30/, `${locale}/${kind} never says 30`);
      assert.doesNotMatch(line, /—|–|<|>/, `${locale}/${kind}: no dashes or angle brackets`);
      assert.doesNotMatch(line, /trial|essai|prueba|Testphase|prøve|试用/i, `${locale}/${kind}: never a trial`);
      if (locale !== 'en') {
        assert.notEqual(line, checkoutReassurance('en', kind), `${locale}/${kind} is translated`);
      }
    }
  }
});

test('the three kinds differ in every locale', () => {
  for (const locale of REASSURANCE_LOCALES) {
    const lines = REASSURANCE_KINDS.map((kind) => checkoutReassurance(locale, kind));
    assert.equal(new Set(lines).size, lines.length, locale);
  }
});

test('locale tags normalise; anything unknown is English', () => {
  assert.equal(reassuranceLocale('nb-NO'), 'nb');
  assert.equal(reassuranceLocale('no'), 'nb');
  assert.equal(reassuranceLocale('zh-CN'), 'zh');
  assert.equal(reassuranceLocale('DE'), 'de');
  assert.equal(reassuranceLocale('it'), 'en');
  assert.equal(reassuranceLocale(undefined), 'en');
  assert.equal(checkoutReassurance('pt', 'pass'), checkoutReassurance('en', 'pass'));
  assert.equal(checkoutReassurance('fr', 'bogus'), checkoutReassurance('fr', 'subscription'));
});
