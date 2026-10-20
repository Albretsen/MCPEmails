import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPortalCustomerOwnership } from './portal-customer.ts';

const caller = { id: 'u1', email: 'Me@Example.test', email_confirmed_at: '2026-06-01T00:00:00Z' };
const owned = ['ws1', 'ws2'];

test('metadata.user_id decides when present', () => {
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', metadata: { user_id: 'u1' } }, caller, owned), { owned: true, via: 'user_id' });
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', metadata: { user_id: 'u2' } }, caller, owned), { owned: false, reason: 'other_user' });
});

test('a user_id naming someone else is final, even with a matching email or workspace', () => {
  const v = verifyPortalCustomerOwnership(
    { id: 'c', email: 'me@example.test', metadata: { user_id: 'u2', workspace_id: 'ws1' } },
    caller,
    owned,
  );
  assert.deepEqual(v, { owned: false, reason: 'other_user' });
});

test('workspace-era metadata must name a workspace the caller owns', () => {
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', metadata: { workspace_id: 'ws2' } }, caller, owned), { owned: true, via: 'workspace_id' });
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', email: 'me@example.test', metadata: { workspace_id: 'ws9' } }, caller, owned), { owned: false, reason: 'other_workspace' });
});

test('no metadata: only the caller\'s confirmed email, compared case-insensitively', () => {
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', email: ' me@example.TEST ', metadata: {} }, caller, owned), { owned: true, via: 'email' });
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', email: 'other@example.test' }, caller, owned), { owned: false, reason: 'no_proof' });
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', email: 'me@example.test' }, { ...caller, email_confirmed_at: null }, owned), { owned: false, reason: 'no_proof' });
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', email: null }, caller, owned), { owned: false, reason: 'no_proof' });
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', email: '' }, { ...caller, email: '' }, owned), { owned: false, reason: 'no_proof' });
});

test('blank metadata values are treated as absent, not as a match', () => {
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', metadata: { user_id: '  ', workspace_id: '' } }, caller, owned), { owned: false, reason: 'no_proof' });
});

test('a deleted customer is never usable', () => {
  assert.deepEqual(verifyPortalCustomerOwnership({ id: 'c', deleted: true, metadata: { user_id: 'u1' } }, caller, owned), { owned: false, reason: 'deleted' });
});
