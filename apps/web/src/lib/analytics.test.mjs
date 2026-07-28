import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeAnalyticsEvent } from './analytics.mjs';

test('accepts documented low-cardinality event properties', () => {
  assert.doesNotThrow(() => assertSafeAnalyticsEvent('inbox_connected', { provider: 'gmail', connection_method: 'oauth' }));
});

test('rejects undeclared events and sensitive properties', () => {
  assert.throws(() => assertSafeAnalyticsEvent('page_view', {}));
  assert.throws(() => assertSafeAnalyticsEvent('signup_completed', { method: 'password', user_id: 'abc' }));
  assert.throws(() => assertSafeAnalyticsEvent('mcp_connection_started', { client: 'https://example.com/?key=mcpe_secret' }));
});
