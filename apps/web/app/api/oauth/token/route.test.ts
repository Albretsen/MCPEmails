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

test('a transient membership lookup failure leaves the chain alone for a retry', async () => {
  seedChain(['read:email']);
  db.failOnce('workspace_members', { message: 'connection reset' });
  const res = await refresh();
  assert.equal(res.status, 500);
  assert.equal(liveChains().length, 1);
  assert.equal(liveChains()[0].refresh_hash, sha256hex(REFRESH));
  assert.equal(liveKeys().length, 1);
});
