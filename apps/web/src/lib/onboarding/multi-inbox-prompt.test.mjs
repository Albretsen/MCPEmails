import test from 'node:test';
import assert from 'node:assert/strict';
import { multiInboxPromptVariant } from './multi-inbox-prompt.mjs';

test('a consumer workspace never sees the prompt', () => {
  for (const atInboxLimit of [true, false]) {
    for (const inboxCount of [0, 1, 2]) {
      assert.equal(multiInboxPromptVariant({ businessShaped: false, inboxCount, atInboxLimit }), null);
    }
  }
  assert.equal(multiInboxPromptVariant(), null);
  assert.equal(multiInboxPromptVariant({ businessShaped: 'true', inboxCount: 1 }), null);
});

test('a business workspace is asked once it has exactly one mailbox', () => {
  assert.equal(multiInboxPromptVariant({ businessShaped: true, inboxCount: 0, atInboxLimit: false }), null);
  assert.equal(multiInboxPromptVariant({ businessShaped: true, inboxCount: 2, atInboxLimit: false }), null);
  assert.equal(multiInboxPromptVariant({ businessShaped: true, inboxCount: 1, atInboxLimit: false }), 'open');
});

test('at the cap the prompt says a second mailbox is paid, never that it is free', () => {
  assert.equal(multiInboxPromptVariant({ businessShaped: true, inboxCount: 1, atInboxLimit: true }), 'upgrade');
});
