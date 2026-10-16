// ---------------------------------------------------------------------------
// POST /api/oauth/token re-checks membership and role on BOTH grants.
//
// The endpoint used to mint an api_keys row for whatever the code or refresh
// chain carried, for whoever it was issued to. So a code consented to minutes
// before the user was removed could still be redeemed, a LEGACY refresh chain
// (api_key_id NULL) minted a brand-new key for an ex-member, and a demoted
// viewer's chain kept rotating write scopes. Every test below asserts the
// resulting rows (api_keys, oauth_refresh_tokens), not just the status code,
// and the owner tests pin that the normal Claude/ChatGPT/Cursor flow is
// byte-for-byte what it was.
//
// Only I/O is stubbed: the Supabase service client is the in-memory fake, and
// the rate limiter, funnel analytics and key-name helper are replaced because
// they need query shapes the fake does not model and are not under test.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/oauth/token/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { computeS256Challenge, sha256hex } from '@/lib/oauth/crypto';
import { hashApiKey } from '@/lib/api-keys/generate';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db: FakeSupabase;

nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: () => db },
});
nodeMock.module('@/lib/rate-limit', {
  namedExports: { checkRateLimit: async () => false },
});
nodeMock.module('@/lib/analytics/product-funnel', {
  namedExports: { recordProductFunnelEvent: async () => undefined },
});
nodeMock.module('@/lib/api-keys/unique-name', {
  namedExports: {
    getActiveApiKeyNames: async () => [],
    disambiguateApiKeyName: (_names: string[], name: string) => name,
  },
});
nodeMock.module('next/server', {
  namedExports: { NextRequest: Request },
});

const { POST } = (await import('./route.ts')) as unknown as { POST: (req: Request) => Promise<Response> };

const CLIENT = 'dyn_testclient';
const WS = 'ws-team';
const USER = 'user-1';
const REDIRECT = 'https://client.example.test/callback';
const VERIFIER = 'a-verifier-that-is-long-enough-for-pkce-0123456789abcdef';
const CODE = 'plain-auth-code';
const REFRESH = 'mcpr_presented_refresh_token';
const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
const FAR_FUTURE = new Date(Date.now() + 100 * 86_400_000).toISOString();

type Row = Record<string, unknown>;

function seedBase(role: string | null): void {
  db = new FakeSupabase();
  db.seed('oauth_clients', [{ client_id: CLIENT, deactivated_at: null }]);
  db.seed('workspaces', [{ id: WS, deleted_at: null }]);
  if (role) db.seed('workspace_members', [{ workspace_id: WS, user_id: USER, role }]);
}

function seedCode(scopes: string[]): void {
  db.seed('oauth_auth_codes', [{
    code_hash: sha256hex(CODE),
    client_id: CLIENT,
    workspace_id: WS,
    user_id: USER,
    client_name: 'Test Client',
    redirect_uri: REDIRECT,
    code_challenge: computeS256Challenge(VERIFIER),
    code_challenge_method: 'S256',
    scopes,
    inbox_ids: null,
    resource: null,
    expires_at: FUTURE,
  }]);
}

/** A chain as the token endpoint leaves it; `linked: false` is a legacy chain. */
function seedChain(scopes: string[], { linked = true, keyScopes = scopes }: { linked?: boolean; keyScopes?: string[] } = {}): unknown {
  let keyId: unknown = null;
  if (linked) {
    db.seed('api_keys', [{
      workspace_id: WS, created_by: USER, name: 'OAuth: Test Client', key_prefix: 'mcpe_old',
      key_hash: hashApiKey('mcpe_old_value'), scopes: keyScopes, inbox_ids: null, expires_at: FUTURE, deleted_at: null,
    }]);
    keyId = db.table('api_keys').at(-1)!.id;
  }
  db.seed('oauth_refresh_tokens', [{
    refresh_hash: sha256hex(REFRESH), client_id: CLIENT, workspace_id: WS, user_id: USER,
    client_name: 'Test Client', scopes, inbox_ids: null, expires_at: FAR_FUTURE,
    api_key_id: keyId, resource: null, revoked_at: null,
  }]);
  return keyId;
}

function post(body: Record<string, string>): Request {
  return new Request('https://mcpemails.test/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

const redeem = () => POST(post({
  grant_type: 'authorization_code', client_id: CLIENT, code: CODE, code_verifier: VERIFIER, redirect_uri: REDIRECT,
}));
const refresh = () => POST(post({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: REFRESH }));

const liveKeys = () => db.table('api_keys').filter((r: Row) => r.deleted_at == null);
const liveChains = () => db.table('oauth_refresh_tokens').filter((r: Row) => r.revoked_at == null);

beforeEach(() => seedBase('owner'));

// ── authorization_code ─────────────────────────────────────────────────────

test('owner: code redemption is unchanged (full scopes, one key, one chain)', async () => {
  const scopes = ['read:email', 'send:email', 'delete:email', 'openid'];
  seedCode(scopes);
  const res = await redeem();
  assert.equal(res.status, 200);
  const body = await res.json() as { access_token: string; refresh_token: string; scope: string };
  assert.equal(body.scope, scopes.join(' '));
  assert.match(body.access_token, /^mcpe_/);
  assert.match(body.refresh_token, /^mcpr_/);

  assert.equal(liveKeys().length, 1);
  assert.deepEqual(liveKeys()[0].scopes, scopes);
  assert.equal(liveKeys()[0].key_hash, hashApiKey(body.access_token));
  assert.equal(liveChains().length, 1);
  assert.deepEqual(liveChains()[0].scopes, scopes);
  assert.equal(db.table('oauth_auth_codes').length, 0, 'the code is consumed');
});

test('admin and member redeem with every scope too', async () => {
  for (const role of ['admin', 'member']) {
    seedBase(role);
    seedCode(['read:email', 'send:email', 'manage:automations']);
    const res = await redeem();
    assert.equal(res.status, 200, role);
    assert.deepEqual(liveKeys()[0].scopes, ['read:email', 'send:email', 'manage:automations'], role);
  }
});

test('removed member: a code issued before removal is refused and mints nothing', async () => {
  seedBase(null);
  seedCode(['read:email', 'send:email']);
  const res = await redeem();
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'invalid_grant');
  assert.equal(db.table('api_keys').length, 0);
  assert.equal(db.table('oauth_refresh_tokens').length, 0);
  assert.equal(db.table('oauth_auth_codes').length, 0, 'the refused code cannot be retried');
});

test('demoted to viewer: a code is narrowed to read-only scopes (identity kept)', async () => {
  seedBase('viewer');
  seedCode(['read:email', 'send:email', 'delete:email', 'openid', 'email']);
  const res = await redeem();
  assert.equal(res.status, 200);
  const body = await res.json() as { scope: string };
  assert.equal(body.scope, 'read:email openid email');
  assert.deepEqual(liveKeys()[0].scopes, ['read:email', 'openid', 'email']);
  assert.deepEqual(liveChains()[0].scopes, ['read:email', 'openid', 'email']);
});

test('demoted to viewer: a write-only code is refused', async () => {
  seedBase('viewer');
  seedCode(['send:email', 'openid']);
  const res = await redeem();
  assert.equal(res.status, 400);
  assert.equal(db.table('api_keys').length, 0);
});

// ── refresh_token ──────────────────────────────────────────────────────────

test('owner: refresh rotates the same key in place and keeps its scopes', async () => {
  const scopes = ['read:email', 'send:email'];
  const keyId = seedChain(scopes);
  const res = await refresh();
  assert.equal(res.status, 200);
  const body = await res.json() as { access_token: string; scope: string };
  assert.equal(body.scope, 'read:email send:email');
  assert.equal(db.table('api_keys').length, 1, 'no new key row');
  assert.equal(liveKeys()[0].id, keyId);
  assert.equal(liveKeys()[0].key_hash, hashApiKey(body.access_token));
  assert.deepEqual(liveKeys()[0].scopes, scopes);
  assert.equal(liveChains().length, 1);
  assert.notEqual(liveChains()[0].refresh_hash, sha256hex(REFRESH), 'the presented token is rotated out');
});

test('owner: a legacy chain still gets its key row created (unchanged)', async () => {
  seedChain(['read:email', 'send:email'], { linked: false });
  const res = await refresh();
  assert.equal(res.status, 200);
  assert.equal(liveKeys().length, 1);
  assert.equal(liveChains().length, 1);
  assert.equal(liveChains()[0].api_key_id, liveKeys()[0].id);
});

test('removed member: refresh is refused and the whole chain and its key end', async () => {
  seedBase(null);
  seedChain(['read:email', 'send:email']);
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, 'invalid_grant');
  assert.equal(liveKeys().length, 0, 'the key is revoked');
  assert.equal(liveChains().length, 0, 'no live refresh row remains');
});

test('removed member: a LEGACY chain no longer mints a brand-new key', async () => {
  seedBase(null);
  seedChain(['read:email', 'send:email'], { linked: false });
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.equal(db.table('api_keys').length, 0);
  assert.equal(liveChains().length, 0);
});

test('demoted to viewer: refresh narrows the chain and the key it rotates', async () => {
  seedBase('viewer');
  seedChain(['read:email', 'search:email', 'send:email', 'openid'], { keyScopes: ['read:email', 'send:email', 'openid'] });
  const res = await refresh();
  assert.equal(res.status, 200);
  const body = await res.json() as { scope: string };
  assert.equal(body.scope, 'read:email search:email openid');
  assert.deepEqual(liveChains()[0].scopes, ['read:email', 'search:email', 'openid']);
  assert.deepEqual(liveKeys()[0].scopes, ['read:email', 'openid'], 'narrowed from the key’s own scopes, never widened');
});

test('demoted to viewer: a legacy chain is narrowed when its key is created', async () => {
  seedBase('viewer');
  seedChain(['read:email', 'manage:automations'], { linked: false });
  const res = await refresh();
  assert.equal(res.status, 200);
  assert.deepEqual(liveKeys()[0].scopes, ['read:email']);
});

test('demoted to viewer: a write-only chain is refused and ended', async () => {
  seedBase('viewer');
  seedChain(['send:email']);
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.equal(liveKeys().length, 0);
  assert.equal(liveChains().length, 0);
});

test('a membership lookup that fails twice in a row leaves the chain alone for a retry', async () => {
  seedChain(['read:email']);
  db.failTimes('workspace_members', { message: 'connection reset' }, 2);
  const res = await refresh();
  assert.equal(res.status, 500);
  assert.equal(liveChains().length, 1);
  assert.equal(liveChains()[0].refresh_hash, sha256hex(REFRESH));
  assert.equal(liveKeys().length, 1);
});

// ── Independent verification (adversarial + legitimate-flow pins) ───────────

test('verify: membership in ANOTHER workspace does not keep a chain alive in this one', async () => {
  db = new FakeSupabase();
  db.seed('oauth_clients', [{ client_id: CLIENT, deactivated_at: null }]);
  db.seed('workspace_members', [{ workspace_id: 'ws-own', user_id: USER, role: 'owner' }]);
  seedChain(['read:email', 'send:email']);
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, 'invalid_grant');
  assert.equal(liveKeys().length, 0);
  assert.equal(liveChains().length, 0);
});

test('verify: membership in ANOTHER workspace does not redeem a code for this one', async () => {
  db = new FakeSupabase();
  db.seed('oauth_clients', [{ client_id: CLIENT, deactivated_at: null }]);
  db.seed('workspace_members', [{ workspace_id: 'ws-own', user_id: USER, role: 'owner' }]);
  seedCode(['read:email']);
  const res = await redeem();
  assert.equal(res.status, 400);
  assert.equal(db.table('api_keys').length, 0);
});

test('verify: owner/admin/member refresh keeps identity scopes openid+email exactly', async () => {
  for (const role of ['owner', 'admin', 'member']) {
    seedBase(role);
    const scopes = ['read:email', 'send:email', 'manage:automations', 'openid', 'email'];
    const keyId = seedChain(scopes);
    const res = await refresh();
    assert.equal(res.status, 200, role);
    const body = await res.json() as { scope: string };
    assert.equal(body.scope, scopes.join(' '), role);
    assert.deepEqual(liveKeys()[0].scopes, scopes, role);
    assert.equal(liveKeys()[0].id, keyId, role);
    assert.deepEqual(liveChains()[0].scopes, scopes, role);
  }
});

test('verify: a viewer already inside the allow-list is not narrowed and keeps identity scopes', async () => {
  seedBase('viewer');
  const scopes = ['read:email', 'search:email', 'openid', 'email'];
  seedChain(scopes, { keyScopes: ['read:email', 'openid'] });
  const res = await refresh();
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { scope: string }).scope, scopes.join(' '));
  assert.deepEqual(liveChains()[0].scopes, scopes);
  assert.deepEqual(liveKeys()[0].scopes, ['read:email', 'openid'], 'key scopes are not rewritten when nothing narrowed');
});

test('verify: after a transient membership failure, the SAME refresh token succeeds on retry', async () => {
  const keyId = seedChain(['read:email', 'send:email']);
  // Two failures: one more than the built-in retry absorbs.
  db.failTimes('workspace_members', { message: 'connection reset' }, 2);
  assert.equal((await refresh()).status, 500);
  const res = await refresh();
  assert.equal(res.status, 200);
  const body = await res.json() as { access_token: string; refresh_token: string };
  assert.equal(liveKeys().length, 1);
  assert.equal(liveKeys()[0].id, keyId);
  assert.equal(liveKeys()[0].key_hash, hashApiKey(body.access_token));
  assert.equal(liveChains().length, 1);
  assert.equal(liveChains()[0].refresh_hash, sha256hex(body.refresh_token));
});

test('verify: a transient membership failure on code redemption is a 500 that mints nothing', async () => {
  seedCode(['read:email', 'send:email']);
  db.failTimes('workspace_members', { message: 'connection reset' }, 2);
  const res = await redeem();
  assert.equal(res.status, 500);
  assert.equal(db.table('api_keys').length, 0);
  assert.equal(db.table('oauth_refresh_tokens').length, 0);
  assert.equal(db.table('oauth_auth_codes').length, 1, 'follow-up 2: the code is NOT consumed by a transient failure');
});

test('verify: ending a removed member\'s chain leaves a colleague\'s key and chain alone', async () => {
  db = new FakeSupabase();
  db.seed('oauth_clients', [{ client_id: CLIENT, deactivated_at: null }]);
  db.seed('workspace_members', [{ workspace_id: WS, user_id: 'colleague', role: 'member' }]);
  db.seed('api_keys', [{
    workspace_id: WS, created_by: 'colleague', name: 'OAuth: Other', key_prefix: 'mcpe_col',
    key_hash: 'h', scopes: ['read:email'], inbox_ids: null, expires_at: FUTURE, deleted_at: null,
  }]);
  const colleagueKey = db.table('api_keys').at(-1)!.id;
  db.seed('oauth_refresh_tokens', [{
    refresh_hash: 'colleague-hash', client_id: CLIENT, workspace_id: WS, user_id: 'colleague',
    client_name: 'Other', scopes: ['read:email'], inbox_ids: null, expires_at: FAR_FUTURE,
    api_key_id: colleagueKey, resource: null, revoked_at: null,
  }]);
  seedChain(['read:email', 'send:email']);
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.deepEqual(liveKeys().map((k: Row) => k.id), [colleagueKey]);
  assert.deepEqual(liveChains().map((c: Row) => c.refresh_hash), ['colleague-hash']);
});

test('verify: owner can refresh repeatedly with each rotated token', async () => {
  const keyId = seedChain(['read:email', 'send:email']);
  let token = REFRESH;
  for (let i = 0; i < 3; i++) {
    const res = await POST(post({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: token }));
    assert.equal(res.status, 200, `rotation ${i}`);
    token = (await res.json() as { refresh_token: string }).refresh_token;
  }
  assert.equal(liveKeys().length, 1);
  assert.equal(liveKeys()[0].id, keyId);
  assert.equal(liveChains().length, 1);
});

// ── Follow-ups: retry, check-before-consume, soft-deleted workspace, endChain errors ──

test('a single membership-lookup blip is absorbed: refresh succeeds first time', async () => {
  const keyId = seedChain(['read:email', 'send:email']);
  db.failOnce('workspace_members', { message: 'connection reset' });
  const res = await refresh();
  assert.equal(res.status, 200);
  assert.equal(liveKeys()[0].id, keyId);
  assert.equal(liveChains().length, 1);
});

test('a single workspace-lookup blip is absorbed on code redemption', async () => {
  seedCode(['read:email']);
  db.failOnce('workspaces', { message: 'connection reset' });
  const res = await redeem();
  assert.equal(res.status, 200);
  assert.equal(liveKeys().length, 1);
});

test('after a transient failure, the SAME code redeems on retry (no new consent needed), exactly once', async () => {
  seedCode(['read:email', 'send:email']);
  db.failTimes('workspace_members', { message: 'connection reset' }, 2);
  assert.equal((await redeem()).status, 500);
  const res = await redeem();
  assert.equal(res.status, 200);
  assert.equal(liveKeys().length, 1);
  assert.equal(db.table('oauth_auth_codes').length, 0);
  const replay = await redeem();
  assert.equal(replay.status, 400, 'still single-use');
  assert.equal(db.table('api_keys').length, 1);
});

test('a code consumed concurrently between the check and the delete mints nothing', async () => {
  seedCode(['read:email']);
  const realFrom = db.from.bind(db);
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = realFrom(t);
    if (t !== 'oauth_auth_codes') return q;
    return {
      ...q,
      delete: () => {
        db.table('oauth_auth_codes').length = 0; // the other request won the race
        return realFrom(t).delete();
      },
    };
  };
  const res = await redeem();
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, 'invalid_grant');
  assert.equal(db.table('api_keys').length, 0);
  assert.equal(db.table('oauth_refresh_tokens').length, 0);
});

test('soft-deleted workspace: code redemption is refused and the code is consumed', async () => {
  db.table('workspaces')[0].deleted_at = new Date().toISOString();
  seedCode(['read:email']);
  const res = await redeem();
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, 'invalid_grant');
  assert.equal(db.table('api_keys').length, 0);
  assert.equal(db.table('oauth_auth_codes').length, 0);
});

test('soft-deleted workspace: refresh is refused and the chain and key end', async () => {
  seedChain(['read:email', 'send:email']);
  db.table('workspaces')[0].deleted_at = new Date().toISOString();
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.equal(liveKeys().length, 0);
  assert.equal(liveChains().length, 0);
});

test('endChain logs a failed revoke by name, still refuses, and still ends the rest', async (t) => {
  seedBase(null);
  seedChain(['read:email', 'send:email']);
  db.failOnce('api_keys', { message: 'disk full' });
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.ok(
    logged.some((a) => a[0] === 'oauth_refresh_end_chain_error' && a[1] === 'api_key' && a[2] === 'disk full'),
    JSON.stringify(logged),
  );
  assert.equal(liveChains().length, 0, 'the refresh rows are still revoked');
});

test('verify: two truly concurrent redemptions of one code mint exactly one key', async () => {
  seedCode(['read:email', 'send:email']);
  const results = await Promise.all([redeem(), redeem(), redeem()]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400, 400]);
  assert.equal(db.table('api_keys').length, 1);
  assert.equal(db.table('oauth_refresh_tokens').length, 1);
  assert.equal(db.table('oauth_auth_codes').length, 0);
});

test('verify: a code refused for non-membership stays refused after the user is re-added', async () => {
  seedBase(null);
  seedCode(['read:email']);
  assert.equal((await redeem()).status, 400);
  db.seed('workspace_members', [{ workspace_id: WS, user_id: USER, role: 'owner' }]);
  assert.equal((await redeem()).status, 400);
  assert.equal(db.table('api_keys').length, 0);
});
