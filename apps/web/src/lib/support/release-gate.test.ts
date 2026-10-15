// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/support/release-gate.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CSRF_SECRET = 'ab'.repeat(32);
process.env.GROWTH_INTERNAL_EMAILS = 'staff@example.com, tester@example.org';

const { supportVisibleTo, mintSupportPreviewToken, readPreviewToken, SUPPORT_PREVIEW_TTL_MS } = await import(
  './release-gate.ts'
);

const GOOD_SECRET = 'ab'.repeat(32);

test.afterEach(() => {
  process.env.CSRF_SECRET = GOOD_SECRET;
  process.env.GROWTH_INTERNAL_EMAILS = 'staff@example.com, tester@example.org';
});

test('our own domains are visible', () => {
  assert.equal(supportVisibleTo('someone@mcpemails.com'), true);
  assert.equal(supportVisibleTo('Someone@MCPEmails.dev'), true);
});

test('GROWTH_INTERNAL_EMAILS entries and their plus-tag aliases are visible', () => {
  assert.equal(supportVisibleTo('staff@example.com'), true);
  assert.equal(supportVisibleTo('staff+qa@example.com'), true);
  assert.equal(supportVisibleTo('tester@example.org'), true);
});

test('an external address, or nobody, is not visible', () => {
  assert.equal(supportVisibleTo('customer@example.net'), false);
  assert.equal(supportVisibleTo('staffx@example.com'), false);
  assert.equal(supportVisibleTo(null), false);
  assert.equal(supportVisibleTo(null, null), false);
  assert.equal(supportVisibleTo(null, ''), false);
});

test('a valid preview token makes a signed-out visitor visible', () => {
  const token = mintSupportPreviewToken('staff@example.com');
  assert.equal(supportVisibleTo(null, token), true);
});

test('an expired token is refused', () => {
  const minted = Date.now() - SUPPORT_PREVIEW_TTL_MS - 1000;
  const token = mintSupportPreviewToken('staff@example.com', minted);
  assert.equal(supportVisibleTo(null, token), false);
  // One millisecond before expiry it still reads.
  assert.equal(readPreviewToken(token, minted + SUPPORT_PREVIEW_TTL_MS - 1), 'staff@example.com');
  assert.equal(readPreviewToken(token, minted + SUPPORT_PREVIEW_TTL_MS), null);
});

test('a tampered token is refused (payload or signature)', () => {
  const token = mintSupportPreviewToken('staff@example.com');
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'staff@example.com', x: Date.now() + 10 * SUPPORT_PREVIEW_TTL_MS })).toString(
    'base64url',
  );
  assert.equal(supportVisibleTo(null, `${forged}.${mac}`), false);
  const bytes = Buffer.from(mac, 'base64url');
  bytes[0] ^= 1;
  const flipped = bytes.toString('base64url');
  assert.equal(supportVisibleTo(null, `${payload}.${flipped}`), false);
  assert.equal(supportVisibleTo(null, `${payload}.`), false);
  assert.equal(supportVisibleTo(null, 'not-a-token'), false);
  assert.equal(supportVisibleTo(null, `${token}.extra`), false);
});

test('a token signed with another secret is refused', () => {
  process.env.CSRF_SECRET = 'cd'.repeat(32);
  const token = mintSupportPreviewToken('staff@example.com');
  process.env.CSRF_SECRET = GOOD_SECRET;
  assert.equal(supportVisibleTo(null, token), false);
});

test('a token for an address that is no longer internal is refused', () => {
  const token = mintSupportPreviewToken('tester@example.org');
  assert.equal(supportVisibleTo(null, token), true);
  process.env.GROWTH_INTERNAL_EMAILS = 'staff@example.com';
  assert.equal(supportVisibleTo(null, token), false);
});

test('a validly signed token for an external address is refused', () => {
  const token = mintSupportPreviewToken('customer@example.net');
  assert.equal(supportVisibleTo(null, token), false);
});

test('missing or malformed CSRF_SECRET fails closed, never throws', () => {
  const token = mintSupportPreviewToken('staff@example.com');
  for (const bad of [undefined, '', 'short', 'zz'.repeat(32)]) {
    if (bad === undefined) delete process.env.CSRF_SECRET;
    else process.env.CSRF_SECRET = bad;
    assert.equal(supportVisibleTo(null, token), false);
    assert.equal(supportVisibleTo('customer@example.net', token), false);
    // The domain rule needs no secret.
    assert.equal(supportVisibleTo('a@mcpemails.com', token), true);
    assert.throws(() => mintSupportPreviewToken('staff@example.com'));
  }
});
