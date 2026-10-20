// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/support/validation.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CSRF_SECRET = 'ab'.repeat(32);

const { issueSupportFormToken } = await import('./form-token.ts');
const { validateTicketRequest, sanitizeSlug, normalizeEmail, SUPPORT_CATEGORIES, SUPPORT_LIMITS } = await import(
  './validation.ts'
);
const { hashSupportIp, clientIp } = await import('./ip.ts');

const NOW = 1_760_000_000_000;
const formToken = issueSupportFormToken(NOW - 30_000);

function body(over: Record<string, unknown> = {}) {
  return {
    category: 'connect',
    subject: 'Cannot connect',
    message: 'It says password rejected.',
    email: 'Visitor@Example.com',
    website: '',
    formToken,
    ...over,
  };
}

const signedOut = { sessionEmail: null, nowMs: NOW };
const signedIn = { sessionEmail: 'member@example.com', nowMs: NOW };

function errorOf(raw: unknown, opts = signedOut) {
  const r = validateTicketRequest(raw, opts);
  return r.kind === 'error' ? r.error : r.kind;
}

test('a good signed-out request is ok, email lowercased, source signed-out', () => {
  const r = validateTicketRequest(body(), signedOut);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.ticket.email, 'visitor@example.com');
  assert.equal(r.ticket.source, 'form_signed_out');
  assert.equal(r.ticket.category, 'connect');
});

test('signed in: the session email wins and the body email is ignored', () => {
  const r = validateTicketRequest(body({ email: 'not an email' }), signedIn);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.ticket.email, 'member@example.com');
  assert.equal(r.ticket.source, 'form_signed_in');
});

test('invalid_json for non-object bodies', () => {
  for (const raw of [null, 'x', 42, [], true]) assert.equal(errorOf(raw), 'invalid_json');
});

test('honeypot filled is a silent drop, before anything else', () => {
  assert.equal(errorOf(body({ website: 'https://spam.example' })), 'drop');
  assert.equal(errorOf({ website: 'x' }), 'drop');
});

test('a too-fast submit is a silent drop', () => {
  assert.equal(errorOf(body({ formToken: issueSupportFormToken(NOW - 1000) })), 'drop');
});

test('invalid_form_token: missing, forged or stale', () => {
  assert.equal(errorOf(body({ formToken: undefined })), 'invalid_form_token');
  assert.equal(errorOf(body({ formToken: `${NOW - 30_000}.AAAA` })), 'invalid_form_token');
  assert.equal(errorOf(body({ formToken: issueSupportFormToken(NOW - 25 * 3600_000) })), 'invalid_form_token');
});

test('invalid_email: missing, malformed, too long', () => {
  assert.equal(errorOf(body({ email: undefined })), 'invalid_email');
  assert.equal(errorOf(body({ email: 'nope' })), 'invalid_email');
  assert.equal(errorOf(body({ email: 'a b@example.com' })), 'invalid_email');
  const long = `${'a'.repeat(SUPPORT_LIMITS.email - '@example.com'.length + 1)}@example.com`;
  assert.equal(long.length, SUPPORT_LIMITS.email + 1);
  assert.equal(errorOf(body({ email: long })), 'invalid_email');
  const max = long.slice(1);
  assert.equal(normalizeEmail(max), max);
});

test('invalid_category for anything outside the list', () => {
  assert.deepEqual([...SUPPORT_CATEGORIES], ['connect', 'client', 'billing', 'bug', 'feature', 'other']);
  for (const c of SUPPORT_CATEGORIES) assert.equal(errorOf(body({ category: c })), 'ok');
  for (const c of [undefined, '', 'Connect', 'sales', 7]) assert.equal(errorOf(body({ category: c })), 'invalid_category');
});

test('subject_required / subject_too_long, with the cap exact', () => {
  assert.equal(errorOf(body({ subject: '' })), 'subject_required');
  assert.equal(errorOf(body({ subject: '   \n ' })), 'subject_required');
  assert.equal(errorOf(body({ subject: 3 })), 'subject_required');
  assert.equal(errorOf(body({ subject: 's'.repeat(SUPPORT_LIMITS.subject) })), 'ok');
  assert.equal(errorOf(body({ subject: 's'.repeat(SUPPORT_LIMITS.subject + 1) })), 'subject_too_long');
});

test('a subject is folded onto one line', () => {
  const r = validateTicketRequest(body({ subject: 'one\r\nBcc: x@example.com' }), signedOut);
  assert.equal(r.kind === 'ok' && r.ticket.subject, 'one Bcc: x@example.com');
});

test('message_required / message_too_long, with the cap exact', () => {
  assert.equal(errorOf(body({ message: '' })), 'message_required');
  assert.equal(errorOf(body({ message: undefined })), 'message_required');
  assert.equal(errorOf(body({ message: 'm'.repeat(SUPPORT_LIMITS.message) })), 'ok');
  assert.equal(errorOf(body({ message: 'm'.repeat(SUPPORT_LIMITS.message + 1) })), 'message_too_long');
});

test('caps are the contract numbers', () => {
  assert.deepEqual({ ...SUPPORT_LIMITS }, { email: 254, subject: 150, message: 5000, slug: 64 });
});

test('slugs: lowercased and kept when clean, dropped otherwise', () => {
  assert.equal(sanitizeSlug('Yahoo'), 'yahoo');
  assert.equal(sanitizeSlug(' imap_auth.failed-2 '), 'imap_auth.failed-2');
  assert.equal(sanitizeSlug('s'.repeat(64)), 's'.repeat(64));
  assert.equal(sanitizeSlug('s'.repeat(65)), null);
  for (const bad of ['', 'has space', 'a/b', '<script>', 'x\ny', 'é', 7, null, undefined]) {
    assert.equal(sanitizeSlug(bad), null);
  }
  const r = validateTicketRequest(body({ from: 'connect-modal', provider: 'Gmail', code: 'bad code!' }), signedOut);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.ticket.from, 'connect-modal');
  assert.equal(r.ticket.provider, 'gmail');
  assert.equal(r.ticket.code, null);
});

test('IP: first x-forwarded-for entry, x-real-ip fallback, keyed hash', () => {
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' })), '203.0.113.5');
  assert.equal(clientIp(new Headers({ 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientIp(new Headers()), null);
  const h = hashSupportIp('203.0.113.5');
  assert.equal(typeof h, 'string');
  assert.equal(h === hashSupportIp('203.0.113.5'), true);
  assert.equal(h === hashSupportIp('203.0.113.6'), false);
  assert.equal(String(h).includes('203'), false);
  assert.equal(hashSupportIp(null), null);
  delete process.env.CSRF_SECRET;
  try {
    assert.equal(hashSupportIp('203.0.113.5'), null);
  } finally {
    process.env.CSRF_SECRET = 'ab'.repeat(32);
  }
});
