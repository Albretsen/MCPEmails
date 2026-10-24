// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/billing/feedback-token.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CSRF_SECRET = 'ef'.repeat(32);

const { issueFeedbackToken, verifyFeedbackToken, FEEDBACK_TOKEN_TTL_MS } = await import('./feedback-token.ts');
const { supportHmac } = await import('@/lib/support/signing');

const T0 = 1_790_000_000_000;
const SCOPE = { subscriptionId: 'sub_1Abc', customerId: 'cus_9Xyz', periodEnd: 1_792_000_000 };

test('a fresh token verifies to the scope it was issued for', () => {
  const token = issueFeedbackToken(SCOPE, T0);
  assert.ok(token.length > 0);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'URL-safe without encoding');
  assert.deepEqual(verifyFeedbackToken(token, T0), SCOPE);
  assert.deepEqual(verifyFeedbackToken(token, T0 + FEEDBACK_TOKEN_TTL_MS - 1000), SCOPE);
});

test('the token lasts 60 days and then stops verifying', () => {
  assert.equal(FEEDBACK_TOKEN_TTL_MS, 60 * 24 * 60 * 60 * 1000);
  const token = issueFeedbackToken(SCOPE, T0);
  assert.equal(verifyFeedbackToken(token, T0 + FEEDBACK_TOKEN_TTL_MS + 1000), null);
});

test('a null customer or period end round-trips', () => {
  const scope = { subscriptionId: 'sub_2', customerId: null, periodEnd: null };
  assert.deepEqual(verifyFeedbackToken(issueFeedbackToken(scope, T0), T0), scope);
});

test('a changed body, a changed MAC or a token of another kind does not verify', () => {
  const token = issueFeedbackToken(SCOPE, T0);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({ v: 1, s: 'sub_other', c: SCOPE.customerId, p: SCOPE.periodEnd, e: 9_999_999_999 }),
  ).toString('base64url');
  assert.equal(verifyFeedbackToken(`${forged}.${mac}`, T0), null, 'body swapped under the old MAC');
  const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyFeedbackToken(`${body}.${flipped}`, T0), null, 'one MAC character changed');
  assert.equal(verifyFeedbackToken(`${body}.${mac.slice(0, 10)}`, T0), null, 'truncated MAC');
  const otherLabel = supportHmac('support-form', body);
  assert.ok(otherLabel);
  assert.equal(verifyFeedbackToken(`${body}.${otherLabel.toString('base64url')}`, T0), null, 'a MAC under another label');
});

test('garbage never verifies and never throws', () => {
  for (const value of [undefined, null, 42, '', '.', 'abc', 'a.b.c', 'x'.repeat(700), '!!.??', {}]) {
    assert.equal(verifyFeedbackToken(value, T0), null, String(value));
  }
});

test('ids that are not Stripe ids are refused at issue time', () => {
  assert.equal(issueFeedbackToken({ ...SCOPE, subscriptionId: 'not-a-sub' }, T0), '');
  assert.equal(issueFeedbackToken({ ...SCOPE, customerId: 'x@y.z' }, T0), '');
  assert.equal(issueFeedbackToken({ ...SCOPE, periodEnd: -5 }, T0), '');
});

test('without a usable secret nothing is issued and nothing verifies', () => {
  const token = issueFeedbackToken(SCOPE, T0);
  const saved = process.env.CSRF_SECRET;
  process.env.CSRF_SECRET = 'short';
  try {
    assert.equal(issueFeedbackToken(SCOPE, T0), '');
    assert.equal(verifyFeedbackToken(token, T0), null);
  } finally {
    process.env.CSRF_SECRET = saved;
  }
});
