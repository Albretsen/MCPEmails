import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHECKOUT_FEEDBACK_DETAIL_MAX,
  CHECKOUT_FEEDBACK_REASONS,
  parseCheckoutFeedback,
} from './checkout-feedback.ts';

test('every fixed reason parses, with no detail', () => {
  for (const reason of CHECKOUT_FEEDBACK_REASONS) {
    assert.deepEqual(parseCheckoutFeedback({ reason }), { reason, detail: null });
  }
});

test('other is the last option', () => {
  assert.equal(CHECKOUT_FEEDBACK_REASONS.at(-1), 'other');
});

test('anything that is not a known reason is refused', () => {
  for (const body of [null, undefined, 'price_too_high', 42, [], {}, { reason: 7 }, { reason: 'free_text' }, { reason: '' }]) {
    assert.equal(parseCheckoutFeedback(body), null);
  }
});

test('other keeps its text, trimmed', () => {
  assert.deepEqual(parseCheckoutFeedback({ reason: 'other', detail: '  needs an invoice  ' }), {
    reason: 'other',
    detail: 'needs an invoice',
  });
});

test('other with nothing typed is still an answer', () => {
  assert.deepEqual(parseCheckoutFeedback({ reason: 'other', detail: '   ' }), { reason: 'other', detail: null });
  assert.deepEqual(parseCheckoutFeedback({ reason: 'other' }), { reason: 'other', detail: null });
  assert.deepEqual(parseCheckoutFeedback({ reason: 'other', detail: 12 }), { reason: 'other', detail: null });
});

test('text on a fixed reason is dropped, matching the column CHECK', () => {
  assert.deepEqual(parseCheckoutFeedback({ reason: 'price_too_high', detail: 'too much' }), { reason: 'price_too_high', detail: null });
});

test('long text is cut to the column limit, not refused', () => {
  const parsed = parseCheckoutFeedback({ reason: 'other', detail: 'x'.repeat(CHECKOUT_FEEDBACK_DETAIL_MAX + 200) });
  assert.equal(parsed?.detail?.length, CHECKOUT_FEEDBACK_DETAIL_MAX);
});
