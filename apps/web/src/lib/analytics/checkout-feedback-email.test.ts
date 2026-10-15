import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHECKOUT_FEEDBACK_REASON_LABELS,
  describeCheckoutTarget,
  describeGap,
  renderCheckoutFeedbackEmail,
  type CheckoutFeedbackContext,
} from '../../../../../supabase/functions/system-notify/checkout-feedback.ts';
import { CHECKOUT_FEEDBACK_REASONS } from './checkout-feedback.ts';

const full: CheckoutFeedbackContext = {
  feedbackId: '11111111-1111-4111-8111-111111111111',
  reason: 'other',
  detail: 'Need an invoice with a VAT number',
  target: 'personal_month',
  answeredAt: '2026-10-02T14:30:22.000Z',
  ownerEmail: 'buyer@example.com',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  workspaceName: 'buyer',
  plan: 'free',
  signedUpAt: '2026-10-02T13:54:01.000Z',
  emailSegment: 'consumer',
  acquisitionSource: 'organic_google',
  marketingOptIn: false,
  inboxCount: 1,
  inboxProviders: ['imap'],
  clients: ['openai-mcp'],
  actionsTotal: 22,
  lastActionAt: '2026-10-02T14:25:00.000Z',
  inboxGateHits: 3,
  checkoutStarts: 1,
  lastCheckoutStartedAt: '2026-10-02T14:30:00.000Z',
  earlierAnswers: 0,
};

test('the notifier has a label for every answer the card can send', () => {
  for (const reason of CHECKOUT_FEEDBACK_REASONS) {
    assert.ok(CHECKOUT_FEEDBACK_REASON_LABELS[reason], `no label for ${reason}`);
  }
});

test('the first body line carries the whole answer', () => {
  const { subject, body } = renderCheckoutFeedbackEmail(full);
  assert.equal(subject, 'Checkout feedback: Other (buyer@example.com)');
  assert.equal(
    body.split('\n')[0],
    '"Need an invoice with a VAT number" | buyer@example.com | wanted Personal, monthly',
  );
});

test('the body says who, what they wanted, and how they use the product', () => {
  const { body } = renderCheckoutFeedbackEmail(full);
  for (const line of [
    'in their words: "Need an invoice with a VAT number"',
    'plan: Personal, monthly',
    'back and answering after: 22 seconds',
    'inbox-limit gate shown: 3 times',
    'email: buyer@example.com',
    'signed up: 2026-10-02T13:54:01.000Z (36 minutes before answering)',
    'marketing opt-in: no',
    'inboxes connected: 1 (imap)',
    'clients: openai-mcp',
    'tool calls, ever: 22',
  ]) {
    assert.ok(body.includes(line), `missing: ${line}`);
  }
});

test('a fixed answer leads with its label and has no quote line', () => {
  const { body } = renderCheckoutFeedbackEmail({ ...full, reason: 'price_too_high', detail: null });
  assert.equal(body.split('\n')[0], 'Costs more than they expected | buyer@example.com | wanted Personal, monthly');
  assert.ok(!body.includes('in their words'));
});

test('missing lookups render as unknown instead of failing', () => {
  const { subject, body } = renderCheckoutFeedbackEmail({
    ...full,
    reason: 'a_new_reason',
    detail: null,
    target: null,
    answeredAt: null,
    ownerEmail: null,
    workspaceName: null,
    plan: null,
    signedUpAt: null,
    emailSegment: null,
    acquisitionSource: null,
    marketingOptIn: null,
    inboxCount: null,
    inboxProviders: [],
    clients: [],
    actionsTotal: null,
    lastActionAt: null,
    inboxGateHits: null,
    checkoutStarts: null,
    lastCheckoutStartedAt: null,
    earlierAnswers: null,
  });
  assert.equal(subject, 'Checkout feedback: a_new_reason (22222222-2222-4222-8222-222222222222)');
  assert.ok(body.includes('plan: unknown'));
  assert.ok(body.includes('email: unknown'));
  assert.ok(body.includes('clients: none'));
  assert.ok(body.includes('last tool call: never'));
  assert.ok(!body.includes('null'));
});

test('targets and gaps read as plain words', () => {
  assert.equal(describeCheckoutTarget('pro_year'), 'Pro, annual');
  assert.equal(describeCheckoutTarget('unknown'), 'unknown');
  assert.equal(describeCheckoutTarget(null), 'unknown');
  assert.equal(describeGap('2026-10-01T00:00:00Z', '2026-10-01T00:00:01Z'), '1 second');
  assert.equal(describeGap('2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z'), '3 days');
  assert.equal(describeGap('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'), null);
  assert.equal(describeGap(null, '2026-10-01T00:00:00Z'), null);
});
