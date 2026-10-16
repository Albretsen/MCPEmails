// Who may change an API key, and what a key's holder caps it to.
// Run: npm run test:api-keys
import assert from 'node:assert/strict';
import test from 'node:test';
import { canChangeApiKey, keyScopeCap, scopeBeyondCap } from '@/lib/api-keys/key-authority';

test('owner and admin may change any key, including one with no creator', () => {
  for (const callerRole of ['owner', 'admin']) {
    assert.equal(canChangeApiKey({ callerRole, callerId: 'me', keyCreatorId: 'someone-else' }), true);
    assert.equal(canChangeApiKey({ callerRole, callerId: 'me', keyCreatorId: null }), true);
  }
});

test('member and viewer may change only a key they created', () => {
  for (const callerRole of ['member', 'viewer']) {
    assert.equal(canChangeApiKey({ callerRole, callerId: 'me', keyCreatorId: 'me' }), true, callerRole);
    assert.equal(canChangeApiKey({ callerRole, callerId: 'me', keyCreatorId: 'someone-else' }), false, callerRole);
    assert.equal(canChangeApiKey({ callerRole, callerId: 'me', keyCreatorId: null }), false, callerRole);
    assert.equal(canChangeApiKey({ callerRole, callerId: '', keyCreatorId: '' }), false, 'empty ids never match');
  }
});

test('an unknown or missing caller role may change nothing, not even "their own" key', () => {
  for (const callerRole of [null, undefined, '', 'superuser']) {
    assert.equal(canChangeApiKey({ callerRole, callerId: 'me', keyCreatorId: 'me' }), false, String(callerRole));
  }
});

test('the scope cap follows the key holder', () => {
  assert.equal(keyScopeCap('viewer'), 'viewer');
  for (const role of ['owner', 'admin', 'member']) assert.equal(keyScopeCap(role), 'none');
  for (const role of [null, undefined, 'ex-member']) assert.equal(keyScopeCap(role), 'no_widen');
});

test('viewer cap: only read:email and search:email, whatever the key held before', () => {
  assert.equal(scopeBeyondCap('viewer', ['read:email', 'search:email'], []), undefined);
  assert.equal(scopeBeyondCap('viewer', ['read:email', 'send:email'], ['send:email']), 'send:email');
});

test('no_widen cap: keep or drop what the key has, add nothing beyond read-only', () => {
  const held = ['read:email', 'send:email'];
  assert.equal(scopeBeyondCap('no_widen', ['read:email', 'send:email'], held), undefined);
  assert.equal(scopeBeyondCap('no_widen', ['send:email'], held), undefined);
  assert.equal(scopeBeyondCap('no_widen', ['read:email', 'search:email'], held), undefined);
  assert.equal(scopeBeyondCap('no_widen', ['send:email', 'delete:email'], held), 'delete:email');
  assert.equal(scopeBeyondCap('no_widen', ['send:email'], null), 'send:email');
});

test('no cap for an operator-held key', () => {
  assert.equal(scopeBeyondCap('none', ['send:email', 'delete:email', 'manage:automations'], []), undefined);
});
