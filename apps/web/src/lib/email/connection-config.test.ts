import test from 'node:test';
import assert from 'node:assert/strict';
import { legacySecurityForPort, normalizeSecurity, safeDiagnosticPhase, yandexLoginUsername } from './connection-config.ts';

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
