// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/support/form-token.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CSRF_SECRET = 'ab'.repeat(32);

const { issueSupportFormToken, checkSupportFormToken, FORM_MIN_FILL_MS, FORM_MAX_AGE_MS } = await import(
  './form-token.ts'
);

const T0 = 1_760_000_000_000;

test('a token checked inside the window is ok', () => {
  const token = issueSupportFormToken(T0);
  assert.equal(checkSupportFormToken(token, T0 + FORM_MIN_FILL_MS), 'ok');
  assert.equal(checkSupportFormToken(token, T0 + 60_000), 'ok');
  assert.equal(checkSupportFormToken(token, T0 + FORM_MAX_AGE_MS), 'ok');
});

test('under 3 seconds is too fast', () => {
  const token = issueSupportFormToken(T0);
  assert.equal(FORM_MIN_FILL_MS, 3_000);
  assert.equal(checkSupportFormToken(token, T0), 'too_fast');
  assert.equal(checkSupportFormToken(token, T0 + FORM_MIN_FILL_MS - 1), 'too_fast');
});

test('older than 24 hours is invalid', () => {
  const token = issueSupportFormToken(T0);
  assert.equal(FORM_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  assert.equal(checkSupportFormToken(token, T0 + FORM_MAX_AGE_MS + 1), 'invalid');
});

test('a token from well in the future is invalid', () => {
  assert.equal(checkSupportFormToken(issueSupportFormToken(T0 + 10 * 60_000), T0), 'invalid');
});

test('a tampered timestamp or signature is invalid', () => {
  const token = issueSupportFormToken(T0);
  const [, mac] = token.split('.');
  assert.equal(checkSupportFormToken(`${T0 - 60_000}.${mac}`, T0), 'invalid');
  assert.equal(checkSupportFormToken(`${T0}.${mac.slice(1)}`, T0 + 10_000), 'invalid');
  for (const junk of [undefined, null, 42, '', 'abc', `${T0}`, `${T0}.`, 'x'.repeat(500)]) {
    assert.equal(checkSupportFormToken(junk, T0 + 10_000), 'invalid');
  }
});

test('a missing secret issues an empty token and checks fail closed', () => {
  const good = issueSupportFormToken(T0);
  delete process.env.CSRF_SECRET;
  try {
    assert.equal(issueSupportFormToken(T0), '');
    assert.equal(checkSupportFormToken(good, T0 + 10_000), 'invalid');
  } finally {
    process.env.CSRF_SECRET = 'ab'.repeat(32);
  }
});
