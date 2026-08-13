import test from 'node:test';
import assert from 'node:assert/strict';
import { legacySecurityForPort, normalizeSecurity, safeDiagnosticPhase, sanitizeAuthDiagnostic, yandexLoginUsername } from './connection-config.ts';

test('Yandex login normalization distinguishes personal and Business accounts', () => {
  assert.equal(yandexLoginUsername('alice@yandex.com', 'personal'), 'alice');
  assert.equal(yandexLoginUsername('alice@example.com', 'business'), 'alice@example.com');
  assert.equal(yandexLoginUsername('alice@yandex.com', 'personal', ' CustomLogin '), 'CustomLogin');
});

test('explicit security is strict and legacy fallback is deterministic', () => {
  assert.equal(normalizeSecurity('starttls'), 'starttls');
  assert.equal(normalizeSecurity('bogus'), 'tls');
  assert.equal(legacySecurityForPort(143, 'imap'), 'starttls');
  assert.equal(legacySecurityForPort(993, 'imap'), 'tls');
  assert.equal(legacySecurityForPort(587, 'smtp'), 'starttls');
  assert.equal(legacySecurityForPort(465, 'smtp'), 'tls');
});

test('diagnostic phases reject mailbox data and arbitrary strings', () => {
  assert.equal(safeDiagnosticPhase('smtp_authentication'), 'smtp_authentication');
  assert.equal(safeDiagnosticPhase('alice@example.com'), null);
  assert.equal(safeDiagnosticPhase('imap.example.com'), null);
  assert.equal(safeDiagnosticPhase({ password: 'secret' }), null);
});

test('auth diagnostics keep the server reason and drop the credentials', () => {
  // The signal that separates a systemic provider failure from a typo: a
  // protocol-level BAD reads differently from a credential-level NO.
  assert.equal(
    sanitizeAuthDiagnostic('BAD', 'AUTHENTICATE Command syntax error. sc=abc123'),
    'BAD AUTHENTICATE Command syntax error. sc=abc123'
  );
  assert.equal(
    sanitizeAuthDiagnostic('NO', '[AUTHENTICATIONFAILED] invalid credentials or IMAP is disabled'),
    'NO [AUTHENTICATIONFAILED] invalid credentials or IMAP is disabled'
  );
});

test('auth diagnostics never persist a credential, login, or address', () => {
  const secrets = ['alice', 'alice@yandex.com', 'hunter2-app-password'];
  const scrubbed = sanitizeAuthDiagnostic(
    'NO',
    'login alice@yandex.com with password hunter2-app-password rejected',
    secrets
  );
  assert.ok(!scrubbed.includes('hunter2-app-password'), 'password must not survive');
  assert.ok(!scrubbed.includes('alice@yandex.com'), 'login must not survive');
  assert.ok(scrubbed.startsWith('NO '));

  // An address the server volunteers that we never sent is masked too.
  assert.equal(
    sanitizeAuthDiagnostic('NO', 'no such user bob@example.org'),
    'NO no such user <address>'
  );
});

test('auth diagnostics are bounded and flattened', () => {
  const long = sanitizeAuthDiagnostic('NO', 'x'.repeat(500));
  assert.ok(long.length <= 160, `expected <=160, got ${long.length}`);
  assert.equal(sanitizeAuthDiagnostic('NO', 'a\r\n\tb   c'), 'NO a b c');
  // An unparseable status must not be echoed back into storage verbatim.
  assert.equal(sanitizeAuthDiagnostic('alice@example.com', ''), 'UNKNOWN');
});

test('an echoed SASL PLAIN token never survives', () => {
  const username = 'alinatest';
  const password = 'hunter2secretpw';
  const token = Buffer.from(`\x00${username}\x00${password}`, 'utf8').toString('base64');

  // A server that echoes the rejected AUTHENTICATE line back. Yandex answers
  // the inline form with "BAD AUTHENTICATE Command syntax error", so a server
  // quoting the offending command is the realistic case, not a contrived one.
  const scrubbed = sanitizeAuthDiagnostic(
    'BAD',
    `AUTHENTICATE PLAIN ${token} Command syntax error`,
    [token, username, password]
  );
  assert.ok(!scrubbed.includes(token), 'the base64 token must not survive');
  assert.ok(!scrubbed.includes(password), 'the password must not survive');

  // Even unlisted (re-encoded, wrapped, or partially echoed) tokens are caught
  // by shape, so the guarantee does not rest on the caller passing the secret.
  const unlisted = sanitizeAuthDiagnostic('BAD', `AUTHENTICATE PLAIN ${token} bad`);
  assert.ok(!unlisted.includes(token), 'an unlisted token must still be removed');
  assert.ok(
    !Buffer.from(unlisted, 'utf8').toString().includes(password),
    'no reversible form of the password may remain'
  );

  // The shape test must not eat the status codes that make a diagnostic useful.
  assert.equal(
    sanitizeAuthDiagnostic('NO', '[AUTHENTICATIONFAILED] invalid credentials or IMAP is disabled'),
    'NO [AUTHENTICATIONFAILED] invalid credentials or IMAP is disabled'
  );
});
