import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeSignupContext,
  CHIP_CLIENTS,
  CHIP_CLIENT_LABELS,
  PRIMARY_CHIP_CLIENTS,
  chipClientFromAcquisition,
  chipClientFromHandshakeName,
  chipClientFromUrl,
  chipClientLabel,
  inferOnboardingClient,
  normalizeChipClient,
} from './clients.mjs';
import { CLIENT_INTENT_PARAM, clientIntentShape, withClientIntent, withConnectIntent } from '../connect/intent-carry.mjs';

test('the chip offers the five common apps first, every id has a label', () => {
  assert.deepEqual([...PRIMARY_CHIP_CLIENTS], ['claude', 'chatgpt', 'claude_code', 'cursor', 'vscode']);
  for (const id of CHIP_CLIENTS) assert.equal(typeof CHIP_CLIENT_LABELS[id], 'string', id);
  assert.equal(chipClientLabel('vscode'), 'VS Code');
  assert.equal(chipClientLabel('nonsense'), 'Claude');
  assert.equal(normalizeChipClient('unknown'), null);
  assert.equal(normalizeChipClient({}), null);
});

test('inference order: param, stored, OAuth client, acquisition, referrer, Claude', () => {
  const all = {
    param: 'cursor',
    stored: 'chatgpt',
    oauthRedirectUri: 'https://claude.ai/api/mcp/auth_callback',
    acquisitionSource: 'connector_chatgpt',
    referrer: 'https://chatgpt.com/',
  };
  assert.deepEqual(inferOnboardingClient(all), { client: 'cursor', source: 'param' });
  assert.deepEqual(inferOnboardingClient({ ...all, param: 'bogus' }), { client: 'chatgpt', source: 'stored' });
  assert.deepEqual(inferOnboardingClient({ ...all, param: null, stored: 'unknown' }), { client: 'claude', source: 'oauth' });
  assert.deepEqual(inferOnboardingClient({ acquisitionSource: 'connector_chatgpt' }), { client: 'chatgpt', source: 'acquisition' });
  assert.deepEqual(inferOnboardingClient({ acquisitionSource: 'organic_google', acquisitionReferrer: 'claude' }), { client: 'claude', source: 'acquisition' });
  assert.deepEqual(inferOnboardingClient({ referrer: 'https://chatgpt.com/c/123' }), { client: 'chatgpt', source: 'referrer' });
  assert.deepEqual(inferOnboardingClient({}), { client: 'claude', source: 'default' });
  assert.deepEqual(inferOnboardingClient(), { client: 'claude', source: 'default' });
});

test('URL mapping covers web hosts and IDE schemes, and refuses lookalikes', () => {
  assert.equal(chipClientFromUrl('https://claude.ai/api/mcp/auth_callback'), 'claude');
  assert.equal(chipClientFromUrl('https://chatgpt.com/connector_platform_oauth_redirect'), 'chatgpt');
  assert.equal(chipClientFromUrl('cursor://anysphere.cursor-retrieval/oauth/callback'), 'cursor');
  assert.equal(chipClientFromUrl('vscode://vscode.github-authentication/did-authenticate'), 'vscode');
  assert.equal(chipClientFromUrl('claude.ai'), 'claude');
  assert.equal(chipClientFromUrl('https://notclaude.ai/'), null);
  assert.equal(chipClientFromUrl('https://claude.ai.evil.example/'), null);
  assert.equal(chipClientFromUrl('http://127.0.0.1:33418/callback'), null);
  assert.equal(chipClientFromUrl(''), null);
  assert.equal(chipClientFromUrl(null), null);
});

test('handshake names map to chip ids, Claude Code before Claude', () => {
  assert.equal(chipClientFromHandshakeName('claude-code'), 'claude_code');
  assert.equal(chipClientFromHandshakeName('Claude Code'), 'claude_code');
  assert.equal(chipClientFromHandshakeName('claude-ai'), 'claude');
  assert.equal(chipClientFromHandshakeName('openai-mcp'), 'chatgpt');
  assert.equal(chipClientFromHandshakeName('cursor-vscode'), 'cursor');
  assert.equal(chipClientFromHandshakeName('Visual Studio Code'), 'vscode');
  assert.equal(chipClientFromHandshakeName('mcp-inspector'), null);
  assert.equal(chipClientFromHandshakeName(undefined), null);
});

test('acquisition values map only from the closed list', () => {
  assert.equal(chipClientFromAcquisition('claude_directory'), 'claude');
  assert.equal(chipClientFromAcquisition('copilot'), 'vscode');
  assert.equal(chipClientFromAcquisition('reddit'), null);
  assert.equal(chipClientFromAcquisition(3), null);
});

test('?client= is carried like ?provider=, shape-checked only', () => {
  assert.equal(CLIENT_INTENT_PARAM, 'client');
  assert.equal(clientIntentShape('claude_code'), 'claude_code');
  assert.equal(clientIntentShape('Claude'), null);
  assert.equal(clientIntentShape('x'), null);
  assert.equal(clientIntentShape('a'.repeat(30)), null);
  assert.equal(clientIntentShape('//evil'), null);
  assert.equal(withClientIntent('/dashboard?firstrun=1', 'chatgpt'), '/dashboard?firstrun=1&client=chatgpt');
  assert.equal(withClientIntent('/dashboard?firstrun=1', null), '/dashboard?firstrun=1');
  assert.equal(withClientIntent('/dashboard?firstrun=1', '<script>'), '/dashboard?firstrun=1');
  assert.equal(
    withClientIntent(withConnectIntent('/dashboard?firstrun=1', 'gmail'), 'claude'),
    '/dashboard?firstrun=1&provider=gmail&client=claude',
  );
});

test('the signup page names the AI app that sent the visitor from /authorize', () => {
  const claude = '/authorize?client_id=' + encodeURIComponent('https://claude.ai/oauth/mcp-oauth-client-metadata') + '&redirect_uri=' + encodeURIComponent('https://claude.ai/api/mcp/auth_callback');
  assert.deepEqual(authorizeSignupContext(claude), { app: 'Claude' });
  const chatgpt = '/authorize?client_id=' + encodeURIComponent('https://chatgpt.com/oauth/abc/client.json') + '&redirect_uri=' + encodeURIComponent('https://chatgpt.com/connector/oauth/abc');
  assert.deepEqual(authorizeSignupContext(chatgpt), { app: 'ChatGPT' });
  assert.deepEqual(authorizeSignupContext('/authorize?client_id=dyn_123&redirect_uri=' + encodeURIComponent('https://example.org/cb')), { app: null });
  assert.equal(authorizeSignupContext('/dashboard'), null);
  assert.equal(authorizeSignupContext(null), null);
});
