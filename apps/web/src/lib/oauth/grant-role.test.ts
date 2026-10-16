// ---------------------------------------------------------------------------
// The role rule for OAuth grants (lib/oauth/grant-role.ts).
//
// One rule decides what a consent may grant and what /api/oauth/token may mint
// or rotate: owner/admin/member keep every scope, a viewer keeps only the
// read-only allow-list, a non-member keeps nothing, and the OIDC identity
// scopes ride along untouched. These tests pin each row of that table, plus the
// "never widen" properties a refactor would most likely break.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/oauth/grant-role.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import { VALID_SCOPES } from '@/lib/api-keys/scopes';
import {
  checkGrantForMember,
  exceedsViewerToolScopes,
  hasToolScope,
  isScopeLimitedRole,
  scopesAllowedForRole,
} from '@/lib/oauth/grant-role';

const ALL = [...VALID_SCOPES];
const WS = 'ws-1';
const USER = 'user-1';

test('owner, admin and member keep every scope, in order', () => {
  for (const role of ['owner', 'admin', 'member']) {
    assert.deepEqual(scopesAllowedForRole(role, [...ALL, 'openid', 'email']), [...ALL, 'openid', 'email']);
    assert.equal(isScopeLimitedRole(role), false);
  }
});

test('a viewer keeps only read:email and search:email, plus identity scopes', () => {
  assert.deepEqual(
    scopesAllowedForRole('viewer', [...ALL, 'openid', 'email']),
    ['read:email', 'search:email', 'openid', 'email'],
  );
  assert.equal(isScopeLimitedRole('viewer'), true);
});

test('an unknown role is capped like a viewer, never widened', () => {
  assert.deepEqual(scopesAllowedForRole('superuser', ALL), ['read:email', 'search:email']);
  assert.equal(isScopeLimitedRole('superuser'), true);
});

test('no role (not a member) keeps nothing', () => {
  assert.deepEqual(scopesAllowedForRole(null, ALL), []);
  assert.deepEqual(scopesAllowedForRole(undefined, ALL), []);
});

test('identity scopes alone are not a tool scope', () => {
  assert.equal(hasToolScope(['openid', 'email']), false);
  assert.equal(hasToolScope(['openid', 'read:email']), true);
});

test('exceedsViewerToolScopes ignores identity scopes and flags any write scope', () => {
  assert.equal(exceedsViewerToolScopes(['read:email', 'openid', 'email']), false);
  assert.equal(exceedsViewerToolScopes(['read:email', 'send:email']), true);
  assert.equal(exceedsViewerToolScopes(['manage:automations']), true);
  assert.equal(exceedsViewerToolScopes(null), false);
});

function db(role: string | null) {
  const fake = new FakeSupabase();
  fake.seed('workspaces', [{ id: WS, deleted_at: null }]);
  if (role) fake.seed('workspace_members', [{ workspace_id: WS, user_id: USER, role }]);
  // A membership of the same user in ANOTHER workspace must not count.
  fake.seed('workspace_members', [{ workspace_id: 'ws-other', user_id: USER, role: 'owner' }]);
  return fake;
}

test('checkGrantForMember: an owner keeps the grant unchanged', async () => {
  const r = await checkGrantForMember(asClient(db('owner')), { workspaceId: WS, userId: USER, scopes: ['read:email', 'send:email'] });
  assert.deepEqual(r, { ok: true, role: 'owner', scopes: ['read:email', 'send:email'], narrowed: false });
});

test('checkGrantForMember: a viewer is narrowed', async () => {
  const r = await checkGrantForMember(asClient(db('viewer')), { workspaceId: WS, userId: USER, scopes: ['read:email', 'send:email', 'openid'] });
  assert.deepEqual(r, { ok: true, role: 'viewer', scopes: ['read:email', 'openid'], narrowed: true });
});

test('checkGrantForMember: a viewer whose grant has no read scope left is refused', async () => {
  const r = await checkGrantForMember(asClient(db('viewer')), { workspaceId: WS, userId: USER, scopes: ['send:email', 'openid'] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'no_allowed_scopes');
});

test('checkGrantForMember: a non-member is refused, membership elsewhere does not count', async () => {
  const r = await checkGrantForMember(asClient(db(null)), { workspaceId: WS, userId: USER, scopes: ['read:email'] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'not_member');
});

test('checkGrantForMember: a lookup error is reported as such, not as non-membership', async () => {
  const fake = db('owner');
  fake.failTimes('workspace_members', { message: 'connection reset' }, 2);
  const r = await checkGrantForMember(asClient(fake), { workspaceId: WS, userId: USER, scopes: ['read:email'] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'lookup_failed');
});

test('checkGrantForMember: one transient error on each read is retried and succeeds', async () => {
  const fake = db('owner');
  fake.failOnce('workspace_members', { message: 'blip' });
  fake.failOnce('workspaces', { message: 'blip' });
  const r = await checkGrantForMember(asClient(fake), { workspaceId: WS, userId: USER, scopes: ['read:email'] });
  assert.equal(r.ok, true);
});

test('checkGrantForMember: a workspace read failing twice is lookup_failed', async () => {
  const fake = db('owner');
  fake.failTimes('workspaces', { message: 'down' }, 2);
  const r = await checkGrantForMember(asClient(fake), { workspaceId: WS, userId: USER, scopes: ['read:email'] });
  assert.equal(!r.ok && r.reason, 'lookup_failed');
});

test('checkGrantForMember: a soft-deleted or missing workspace is refused even for its owner', async () => {
  const deleted = db('owner');
  deleted.table('workspaces')[0].deleted_at = '2026-10-16T00:00:00.000Z';
  const r1 = await checkGrantForMember(asClient(deleted), { workspaceId: WS, userId: USER, scopes: ['read:email'] });
  assert.equal(!r1.ok && r1.reason, 'workspace_deleted');

  const missing = db('owner');
  missing.tables.set('workspaces', []);
  const r2 = await checkGrantForMember(asClient(missing), { workspaceId: WS, userId: USER, scopes: ['read:email'] });
  assert.equal(!r2.ok && r2.reason, 'workspace_deleted');
});
