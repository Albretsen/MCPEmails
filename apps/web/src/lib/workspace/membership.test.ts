// ---------------------------------------------------------------------------
// Membership teardown reaches the OAuth half of a member's credentials.
//
// Removal and leave used to revoke api_keys only, and demotion to viewer
// revoked over-scoped api_keys only. Pending authorization codes and refresh
// chains were untouched, so an ex-member could redeem a code minted minutes
// earlier, and a LEGACY chain (api_key_id NULL) would mint a brand-new key on
// its next refresh. The property asserted here is the state of every table
// afterwards, not which calls were made.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/workspace/membership.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import {
  removeWorkspaceMember,
  revokeApiKeysBeyondViewerScopes,
} from '@/lib/workspace/membership';

const WS = 'ws-team';
const OTHER_WS = 'ws-own';
const USER = 'user-leaving';
const COLLEAGUE = 'user-staying';

type Row = Record<string, unknown>;

function world(): FakeSupabase {
  const db = new FakeSupabase();
  db.seed('workspace_members', [
    { workspace_id: WS, user_id: USER, role: 'admin' },
    { workspace_id: WS, user_id: COLLEAGUE, role: 'member' },
    { workspace_id: OTHER_WS, user_id: USER, role: 'owner' },
  ]);
  db.seed('api_keys', [
    { key: 'write', workspace_id: WS, created_by: USER, scopes: ['read:email', 'send:email'], deleted_at: null },
    { key: 'read-oauth', workspace_id: WS, created_by: USER, scopes: ['read:email', 'openid', 'email'], deleted_at: null },
    { key: 'colleague', workspace_id: WS, created_by: COLLEAGUE, scopes: ['send:email'], deleted_at: null },
    { key: 'own-ws', workspace_id: OTHER_WS, created_by: USER, scopes: ['send:email'], deleted_at: null },
  ]);
  const keyId = (k: string) => db.table('api_keys').find((r) => r.key === k)!.id;
  db.seed('oauth_refresh_tokens', [
    { chain: 'write', workspace_id: WS, user_id: USER, scopes: ['read:email', 'send:email'], api_key_id: keyId('write'), revoked_at: null },
    { chain: 'read', workspace_id: WS, user_id: USER, scopes: ['read:email', 'openid'], api_key_id: keyId('read-oauth'), revoked_at: null },
    { chain: 'legacy-write', workspace_id: WS, user_id: USER, scopes: ['send:email'], api_key_id: null, revoked_at: null },
    { chain: 'legacy-read', workspace_id: WS, user_id: USER, scopes: ['read:email'], api_key_id: null, revoked_at: null },
    { chain: 'colleague', workspace_id: WS, user_id: COLLEAGUE, scopes: ['send:email'], api_key_id: keyId('colleague'), revoked_at: null },
    { chain: 'own-ws', workspace_id: OTHER_WS, user_id: USER, scopes: ['send:email'], api_key_id: keyId('own-ws'), revoked_at: null },
  ]);
  db.seed('oauth_auth_codes', [
    { code: 'pending-write', workspace_id: WS, user_id: USER, scopes: ['send:email'] },
    { code: 'pending-read', workspace_id: WS, user_id: USER, scopes: ['read:email', 'openid'] },
    { code: 'colleague', workspace_id: WS, user_id: COLLEAGUE, scopes: ['send:email'] },
    { code: 'own-ws', workspace_id: OTHER_WS, user_id: USER, scopes: ['send:email'] },
  ]);
  return db;
}

const liveKeys = (db: FakeSupabase) =>
  db.table('api_keys').filter((r: Row) => r.deleted_at == null).map((r: Row) => r.key).sort();
const liveChains = (db: FakeSupabase) =>
  db.table('oauth_refresh_tokens').filter((r: Row) => r.revoked_at == null).map((r: Row) => r.chain).sort();
const codes = (db: FakeSupabase) => db.table('oauth_auth_codes').map((r: Row) => r.code).sort();

test('removal revokes keys, refresh chains (legacy too) and pending codes in that workspace only', async () => {
  const db = world();
  const { error } = await removeWorkspaceMember(asClient(db), WS, USER);
  assert.equal(error, null);

  assert.deepEqual(liveKeys(db), ['colleague', 'own-ws']);
  assert.deepEqual(liveChains(db), ['colleague', 'own-ws'], 'every chain of the leaver in WS ends, legacy ones included');
  assert.deepEqual(codes(db), ['colleague', 'own-ws'], 'pending codes of the leaver in WS are gone');
  assert.deepEqual(
    db.table('workspace_members').map((r: Row) => `${r.workspace_id}:${r.user_id}`).sort(),
    [`${OTHER_WS}:${USER}`, `${WS}:${COLLEAGUE}`],
  );
});

test('removal stops before dropping the membership if the OAuth revocation fails', async () => {
  const db = world();
  db.failOnce('oauth_auth_codes', { message: 'boom' });
  const { error } = await removeWorkspaceMember(asClient(db), WS, USER);
  assert.ok(error);
  assert.ok(
    db.table('workspace_members').some((r: Row) => r.workspace_id === WS && r.user_id === USER),
    'the membership row stays so the admin can retry',
  );
});

test('demotion to viewer revokes write keys, write chains and write codes; read-only ones survive', async () => {
  const db = world();
  const { revokedKeyIds, error } = await revokeApiKeysBeyondViewerScopes(asClient(db), WS, USER);
  assert.equal(error, null);
  assert.equal(revokedKeyIds.length, 1);

  assert.deepEqual(liveKeys(db), ['colleague', 'own-ws', 'read-oauth'], 'openid/email do not make a read key over-privileged');
  assert.deepEqual(liveChains(db), ['colleague', 'legacy-read', 'own-ws', 'read']);
  assert.deepEqual(codes(db), ['colleague', 'own-ws', 'pending-read']);
});

test('demotion reports a failure on the OAuth half instead of claiming success', async () => {
  const db = world();
  db.failOnce('oauth_refresh_tokens', { message: 'boom' });
  const { error } = await revokeApiKeysBeyondViewerScopes(asClient(db), WS, USER);
  assert.ok(error);
});
