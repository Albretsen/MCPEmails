// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs app/[locale]/billing/feedback/content.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { FEEDBACK_COPY, feedbackCopy } from './content.mjs';
import { CANCEL_REASONS } from '../../../../src/lib/billing/cancel-reasons.ts';
import { routing } from '../../../../src/i18n/routing.ts';

function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function strings(value) {
  return Object.values(value).flatMap((v) => (v && typeof v === 'object' ? strings(v) : [v]));
}

test('every routed locale has the page copy, with the same keys as English', () => {
  const expected = keys(FEEDBACK_COPY.en).sort();
  for (const locale of routing.locales) {
    assert.ok(FEEDBACK_COPY[locale], `${locale} is missing`);
    assert.deepEqual(keys(FEEDBACK_COPY[locale]).sort(), expected, locale);
  }
  assert.equal(feedbackCopy('xx'), FEEDBACK_COPY.en, 'unknown locales fall back to English');
});

test('the reasons are the seven fixed answers, in order', () => {
  for (const [locale, copy] of Object.entries(FEEDBACK_COPY)) {
    assert.deepEqual(Object.keys(copy.reasons), [...CANCEL_REASONS], locale);
  }
});

test('no angle brackets, no em dash, no offer and German is formal', () => {
  for (const [locale, copy] of Object.entries(FEEDBACK_COPY)) {
    for (const s of strings(copy)) {
      assert.equal(typeof s, 'string');
      assert.ok(s.trim().length > 0, `${locale}: empty string`);
      assert.ok(!/[<>]/.test(s), `${locale}: angle bracket in "${s}"`);
      assert.ok(!s.includes('—'), `${locale}: em dash in "${s}"`);
    }
    const all = strings(copy).join(' ');
    assert.ok(!/discount|pause|downgrade|rabatt|rabais|descuento/i.test(all), `${locale}: no offer on the reason page`);
  }
  const de = strings(FEEDBACK_COPY.de).join(' ');
  assert.ok(/\bSie\b/.test(de), 'de uses Sie');
  assert.ok(!/\b(du|dein|deine|dich|dir)\b/i.test(de), 'de never uses du');
});

test('the thank-you line is exactly the one sentence', () => {
  assert.equal(FEEDBACK_COPY.en.thanks, 'Thanks, that helps.');
});
