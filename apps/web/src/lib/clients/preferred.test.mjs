// Run with: npm run test:preferred-client
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CLIENTS, AI_CLIENT_NAMES, aiClientFromRequest, aiClientFromSignal, normalizeAiClient, orderClients,
  serializeAiClientCookie, signupClientParam,
} from './preferred.mjs';
import { getClient } from './clients.mjs';

const at = (path) => new URL(path, 'https://mcpemails.com');

test('every AI client has a /docs page and a display name', () => {
  for (const slug of AI_CLIENTS) {
    assert.ok(getClient(slug), `no /docs/${slug}`);
    assert.ok(AI_CLIENT_NAMES[slug], `no name for ${slug}`);
  }
});

test('aiClientFromSignal maps assistant categories and nothing else', () => {
  for (const [category, slug] of [
    ['claude', 'claude'], ['claude_directory', 'claude'], ['connector_claude', 'claude'],
    ['chatgpt', 'chatgpt'], ['chatgpt_directory', 'chatgpt'], ['connector_chatgpt', 'chatgpt'],
    ['cursor', 'cursor'], ['cursor_directory', 'cursor'], ['connector_cursor', 'cursor'],
    ['perplexity', 'perplexity'], ['gemini', 'gemini'],
  ]) assert.equal(aiClientFromSignal(category), slug, category);
  for (const category of ['direct', 'organic_google', 'reddit', 'smithery', 'other', 'copilot', null, undefined, 42]) {
    assert.equal(aiClientFromSignal(category), null, String(category));
  }
});

test('aiClientFromRequest: utm_source, then ref/source, then the Referer host', () => {
  assert.equal(aiClientFromRequest(at('/?utm_source=chatgpt.com'), null), 'chatgpt');
  assert.equal(aiClientFromRequest(at('/?utm_source=ChatGPT'), 'https://claude.ai/'), 'chatgpt');
  assert.equal(aiClientFromRequest(at('/?utm_source=perplexity'), null), 'perplexity');
  assert.equal(aiClientFromRequest(at('/docs?ref=cursor_directory'), null), 'cursor');
  assert.equal(aiClientFromRequest(at('/'), 'https://claude.ai/chat/abc'), 'claude');
  assert.equal(aiClientFromRequest(at('/'), 'https://www.perplexity.ai/search?q=x'), 'perplexity');
  assert.equal(aiClientFromRequest(at('/'), 'https://gemini.google.com/app'), 'gemini');
  assert.equal(aiClientFromRequest(at('/pricing'), 'https://chatgpt.com/'), 'chatgpt');
  // Not assistants.
  assert.equal(aiClientFromRequest(at('/'), 'https://www.google.com/'), null);
  assert.equal(aiClientFromRequest(at('/?utm_source=newsletter'), null), null);
  assert.equal(aiClientFromRequest(at('/?ref=nav'), null), null);
  assert.equal(aiClientFromRequest(at('/'), null), null);
  assert.equal(aiClientFromRequest(at('/'), ''), null);
  assert.equal(aiClientFromRequest(at('/'), 'not a url'), null);
  // Our own pages as referrer never count.
  assert.equal(aiClientFromRequest(at('/pricing'), 'https://mcpemails.com/'), null);
  // A non-AI utm falls through to the Referer.
  assert.equal(aiClientFromRequest(at('/?utm_source=newsletter'), 'https://claude.ai/'), 'claude');
});

test('orderClients is a stable move-to-front and never mutates its input', () => {
  const list = Object.freeze(['claude', 'chatgpt', 'cursor', 'vscode']);
  assert.deepEqual(orderClients(list, 'cursor'), ['cursor', 'claude', 'chatgpt', 'vscode']);
  assert.deepEqual(orderClients(list, 'claude'), ['claude', 'chatgpt', 'cursor', 'vscode']);
  assert.deepEqual(orderClients(list, null), [...list]);
  assert.deepEqual(orderClients(list, 'perplexity'), [...list]);
  const objs = [{ s: 'a', n: 1 }, { s: 'b', n: 2 }, { s: 'a', n: 3 }];
  assert.deepEqual(orderClients(objs, 'a', (o) => o.s).map((o) => o.n), [1, 3, 2]);
});

test('signupClientParam names only onboarding chip ids', () => {
  assert.equal(signupClientParam('claude'), 'claude');
  assert.equal(signupClientParam('chatgpt'), 'chatgpt');
  assert.equal(signupClientParam('cursor'), 'cursor');
  assert.equal(signupClientParam('claude-code'), 'claude_code');
  assert.equal(signupClientParam('gemini-cli'), 'gemini');
  assert.equal(signupClientParam('perplexity'), null);
  assert.equal(signupClientParam('codex'), null);
  assert.equal(signupClientParam(null), null);
});

test('the cookie is HttpOnly, Lax, 30 days, Secure on https, and only for AI slugs', () => {
  assert.equal(
    serializeAiClientCookie('chatgpt', true),
    'mx_ai_client=chatgpt; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure',
  );
  assert.equal(serializeAiClientCookie('claude', false).includes('Secure'), false);
  assert.equal(serializeAiClientCookie('evil; Domain=x', true), null);
  assert.equal(normalizeAiClient('vscode'), null);
});
