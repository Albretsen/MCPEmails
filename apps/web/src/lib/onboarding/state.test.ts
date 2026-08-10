import test from 'node:test';
import assert from 'node:assert/strict';
import { clientGuidePath, normalizeOnboardingClient, onboardingActionPayload } from './state.ts';

test('accepts only coarse supported client categories', () => {
  assert.equal(normalizeOnboardingClient('claude'), 'claude');
  assert.equal(normalizeOnboardingClient('curl'), 'curl');
  assert.equal(normalizeOnboardingClient('Claude Desktop'), null);
  assert.equal(normalizeOnboardingClient({ client: 'claude' }), null);
});

test('builds a same-origin dashboard guide path without accepting arbitrary input', () => {
  assert.equal(clientGuidePath('cursor'), '/dashboard?onboarding_client=cursor');
  assert.equal(clientGuidePath('//evil.example'), '/dashboard');
});

test('validates action-specific payloads', () => {
  assert.deepEqual(onboardingActionPayload('started'), { action: 'started' });
  assert.deepEqual(onboardingActionPayload('client_selected', 'claude'), { action: 'client_selected', client: 'claude' });
  assert.deepEqual(onboardingActionPayload('provider_selected', 'generic_imap'), { action: 'provider_selected', provider: 'generic_imap' });
  assert.equal(onboardingActionPayload('client_selected', 'made-up'), null);
});
