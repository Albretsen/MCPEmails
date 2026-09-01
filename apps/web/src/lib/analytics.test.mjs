import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeAnalyticsEvent } from './analytics.mjs';

test('accepts documented low-cardinality event properties', () => {
  assert.doesNotThrow(() => assertSafeAnalyticsEvent('inbox_connected', { provider: 'gmail', connection_method: 'oauth' }));
  // Regression: the value 'app_password' contains "password" and was rejected
  // by a sensitive-value regex, so this event threw for EVERY app-password
  // provider. The old test only ever exercised 'oauth', which is why it stood.
  for (const provider of ['gmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'fastmail', 'imap']) {
    assert.doesNotThrow(() => assertSafeAnalyticsEvent('inbox_connected', { provider, connection_method: 'app_password' }));
  }
});

test('rejects undeclared events and sensitive properties', () => {
  assert.throws(() => assertSafeAnalyticsEvent('page_view', {}));
  assert.throws(() => assertSafeAnalyticsEvent('signup_completed', { method: 'password', user_id: 'abc' }));
  assert.throws(() => assertSafeAnalyticsEvent('mcp_connection_started', { client: 'https://example.com/?key=mcpe_secret' }));
});
