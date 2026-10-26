import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_RETURN_TTL_MS, backToChatPath, rememberChatReturn, takeChatReturn, withoutChatLinkParams } from './chat-return.mjs';

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('remembered once, read once', () => {
  const store = memoryStore();
  rememberChatReturn({ client: 'claude', provider: 'gmail' }, { store, now: 1000 });
  assert.deepEqual(takeChatReturn({ store, now: 2000 }), { client: 'claude' });
  assert.equal(takeChatReturn({ store, now: 2000 }), null);
});

test('stale or junk is null', () => {
  const store = memoryStore();
  rememberChatReturn({ client: 'chatgpt' }, { store, now: 0 });
  assert.equal(takeChatReturn({ store, now: CHAT_RETURN_TTL_MS + 1 }), null);
  store.setItem('mcpe-chat-return', '{not json');
  assert.equal(takeChatReturn({ store }), null);
});

test('backToChatPath carries a chip id and nothing else', () => {
  assert.equal(backToChatPath('claude'), '/onboarding/back-to-chat?client=claude');
  assert.equal(backToChatPath('x&y=1'), '/onboarding/back-to-chat');
  assert.equal(backToChatPath(null), '/onboarding/back-to-chat');
});

test('withoutChatLinkParams drops the link parameters and keeps the rest', () => {
  assert.equal(
    withoutChatLinkParams('https://mcpemails.com/dashboard/inboxes?provider=gmail&from=chat&client=claude&exp=1&sig=x'),
    'https://mcpemails.com/dashboard/inboxes?provider=gmail',
  );
  const plain = 'https://mcpemails.com/dashboard?client=claude';
  assert.equal(withoutChatLinkParams(plain), plain);
});
