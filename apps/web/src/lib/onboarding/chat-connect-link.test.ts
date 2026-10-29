import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signChatConnectLink, verifyChatConnectLink, withChatLinkParams } from './chat-connect-link.ts';

// The shared vector. supabase/functions/mcp-server/no-inbox-answer.test.ts
// checks the SAME inputs give the SAME signature; change both or neither.
const VECTOR = {
  keyHex: '0123456789abcdef'.repeat(4),
  workspaceId: '11111111-2222-3333-4444-555555555555',
  exp: 1893456000,
  provider: 'gmail',
  client: 'claude',
  sig: 'h_1vy3iJ2iy_aRY5wTCBAm3eHgxZ_f3wBU1REzLbLZk',
};
const NOW = (VECTOR.exp - 3600) * 1000;

function params(overrides: Record<string, string | undefined> = {}) {
  return {
    from: 'chat', client: VECTOR.client, provider: VECTOR.provider, exp: String(VECTOR.exp), sig: VECTOR.sig, ...overrides,
  };
}

test('signature matches the shared mcp-server vector', () => {
  assert.equal(signChatConnectLink(VECTOR.keyHex, VECTOR.workspaceId, VECTOR.exp, VECTOR.provider, VECTOR.client), VECTOR.sig);
  assert.equal(signChatConnectLink(VECTOR.keyHex.toUpperCase(), VECTOR.workspaceId, VECTOR.exp, VECTOR.provider, VECTOR.client), VECTOR.sig);
});

test('a valid link for this workspace verifies', () => {
  assert.deepEqual(
    verifyChatConnectLink(params(), VECTOR.workspaceId, { keyHex: VECTOR.keyHex, nowMs: NOW }),
    { client: 'claude', provider: 'gmail' },
  );
});

test('another workspace, a tampered value, an expired link or no key: null', () => {
  const opts = { keyHex: VECTOR.keyHex, nowMs: NOW };
  assert.equal(verifyChatConnectLink(params(), '99999999-2222-3333-4444-555555555555', opts), null);
  assert.equal(verifyChatConnectLink(params({ provider: 'yahoo' }), VECTOR.workspaceId, opts), null);
  assert.equal(verifyChatConnectLink(params({ client: 'chatgpt' }), VECTOR.workspaceId, opts), null);
  assert.equal(verifyChatConnectLink(params({ client: 'not a client' }), VECTOR.workspaceId, opts), null);
  assert.equal(verifyChatConnectLink(params({ sig: 'x' }), VECTOR.workspaceId, opts), null);
  assert.equal(verifyChatConnectLink(params({ from: undefined }), VECTOR.workspaceId, opts), null);
  assert.equal(verifyChatConnectLink(params(), VECTOR.workspaceId, { keyHex: VECTOR.keyHex, nowMs: VECTOR.exp * 1000 }), null);
  assert.equal(verifyChatConnectLink(params(), VECTOR.workspaceId, { keyHex: null, nowMs: NOW }), null);
  assert.equal(verifyChatConnectLink(params(), null, opts), null);
});

test('withChatLinkParams carries exactly the link parameters', () => {
  assert.equal(
    withChatLinkParams('/onboarding', { ...params(), other: 'x' }),
    `/onboarding?from=chat&client=claude&provider=gmail&exp=${VECTOR.exp}&sig=${VECTOR.sig}`,
  );
});
