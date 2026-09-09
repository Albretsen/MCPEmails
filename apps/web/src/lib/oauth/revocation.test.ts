// ---------------------------------------------------------------------------
// RFC 7009 revocation: does presenting a token actually END the connection?
//
// This suite exists because of a live incident on 2026-09-09. A claude.ai
// connector was disconnected AND removed inside Claude, and on our side both
// halves of the grant were still fully live: api_keys.deleted_at NULL,
// oauth_refresh_tokens.revoked_at NULL. The Vercel logs showed why: no request
// ever reached /api/oauth/revoke. But reading the endpoint afterwards turned up
// a second, independent defect that nobody had noticed because nothing had ever
// exercised it: it revoked ONE HALF of the grant. A refresh token revoked the
// refresh row and left the mcpe_ access token live for up to an hour; an access
// token soft-deleted the key and left the chain alone.
//
// So the property under test throughout is not "a row changed". It is "NO
// USABLE CREDENTIAL REMAINS", asserted against both tables after every call.
//
// The other half of the spec is negative and just as load-bearing: RFC 7009
// §2.2 requires 200 for an unknown or already-revoked token, so this endpoint
// can never be an oracle for token validity, and §2.1 requires the search to
// extend past a wrong `token_type_hint` rather than no-op. Those are the tests
// that would otherwise never be written.
//
// The Supabase client is the in-memory fake from the billing suite. It is
// shared rather than duplicated because the shapes used here (update + eq + is
// + select, maybeSingle) are exactly the ones it already models, and a second
// copy would be a second thing to keep honest.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/oauth/revocation.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import { hashApiKey } from '@/lib/api-keys/generate';
import { sha256hex } from '@/lib/oauth/crypto';
import {
  loggableClientId,
  revocationLookupOrder,
  revokeGrantByToken,
} from '@/lib/oauth/revocation';

const KEY_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_KEY_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const WORKSPACE = 'bbbbbbbb-0000-4000-8000-000000000001';
const ACCESS = 'mcpe_liveaccesstokenvalue';
const REFRESH = 'mcpr_liverefreshtokenvalue';
const CIMD_CLIENT = 'https://claude.ai/api/mcp/cimd';

/**
 * One connection exactly as the token endpoint leaves it: a single api_keys row
 * and one live refresh row pointing at it.
 */
function grant(
  overrides: {
    clientId?: string;
    keyDeletedAt?: string | null;
    refreshRevokedAt?: string | null;
    apiKeyId?: string | null;
  } = {},
): FakeSupabase {
  const db = new FakeSupabase();
  db.seed('api_keys', [
    {
      id: KEY_ID,
      workspace_id: WORKSPACE,
      name: 'OAuth: Claude',
      key_prefix: 'liveacce',
      key_hash: hashApiKey(ACCESS),
      deleted_at: overrides.keyDeletedAt ?? null,
    },
  ]);
  db.seed('oauth_refresh_tokens', [
    {
      id: 'cccccccc-0000-4000-8000-000000000001',
      refresh_hash: sha256hex(REFRESH),
      api_key_id: overrides.apiKeyId === undefined ? KEY_ID : overrides.apiKeyId,
      workspace_id: WORKSPACE,
      client_id: overrides.clientId ?? 'dyn_1b0c5eda0895e91e59dcc2ac',
      revoked_at: overrides.refreshRevokedAt ?? null,
    },
  ]);
  return db;
}

function keys(db: FakeSupabase) {
  return db.table('api_keys');
}
function refreshes(db: FakeSupabase) {
  return db.table('oauth_refresh_tokens');
}

/** The only assertion that matters: nothing usable is left. */
function assertGrantIsDead(db: FakeSupabase, keyId = KEY_ID): void {
  const key = keys(db).find((r) => r.id === keyId);
  assert.ok(key, 'expected the api_keys row to still exist (soft delete, not hard delete)');
  assert.ok(key.deleted_at, 'access token still live after revocation');
  for (const row of refreshes(db).filter((r) => r.api_key_id === keyId)) {
    assert.ok(row.revoked_at, 'refresh token still live after revocation');
  }
}

/* ── The whole grant dies, from either half ──────────────────────────────── */

test('a refresh token revokes the access token too, not just its own row', async () => {
  const db = grant();
  const out = await revokeGrantByToken(asClient(db), { token: REFRESH });

  assert.equal(out.revoked, true);
  assert.equal(out.matchedAs, 'refresh_token');
  assert.equal(out.apiKeyId, KEY_ID);
  assert.equal(out.accessTokensRevoked, 1);
  assert.equal(out.refreshTokensRevoked, 1);
  assertGrantIsDead(db);
});

test('an access token revokes the refresh chain too, not just its own row', async () => {
  const db = grant();
  const out = await revokeGrantByToken(asClient(db), { token: ACCESS });

  assert.equal(out.revoked, true);
  assert.equal(out.matchedAs, 'access_token');
  assert.equal(out.apiKeyId, KEY_ID);
  assert.equal(out.accessTokensRevoked, 1);
  assert.equal(out.refreshTokensRevoked, 1);
  assertGrantIsDead(db);
});

test('every live row of a rotated chain dies, not only the one presented', async () => {
  // A refresh that failed between "insert the new row" and "revoke the old one"
  // leaves two live rows on the same api_keys id. Revoking the grant means both.
  const db = grant();
  db.seed('oauth_refresh_tokens', [
    {
      id: 'cccccccc-0000-4000-8000-000000000002',
      refresh_hash: sha256hex('mcpr_thesecondliverow'),
      api_key_id: KEY_ID,
      workspace_id: WORKSPACE,
      client_id: 'dyn_1b0c5eda0895e91e59dcc2ac',
      revoked_at: null,
    },
  ]);

  const out = await revokeGrantByToken(asClient(db), { token: REFRESH });

  assert.equal(out.refreshTokensRevoked, 2);
  assertGrantIsDead(db);
});

test('a different connection in the same workspace is untouched', async () => {
  const db = grant();
  db.seed('api_keys', [
    {
      id: OTHER_KEY_ID,
      workspace_id: WORKSPACE,
      name: 'OAuth: Claude (2)',
      key_prefix: 'otheracc',
      key_hash: hashApiKey('mcpe_someothersconnection'),
      deleted_at: null,
    },
  ]);
  db.seed('oauth_refresh_tokens', [
    {
      id: 'cccccccc-0000-4000-8000-000000000003',
      refresh_hash: sha256hex('mcpr_someothersconnection'),
      api_key_id: OTHER_KEY_ID,
      workspace_id: WORKSPACE,
      client_id: 'dyn_1b0c5eda0895e91e59dcc2ac',
      revoked_at: null,
    },
  ]);

  await revokeGrantByToken(asClient(db), { token: REFRESH });

  const other = keys(db).find((r) => r.id === OTHER_KEY_ID);
  assert.equal(other?.deleted_at, null);
  const otherChain = refreshes(db).find((r) => r.api_key_id === OTHER_KEY_ID);
  assert.equal(otherChain?.revoked_at, null);
});

/* ── token_type_hint is advisory (RFC 7009 §2.1) ─────────────────────────── */

test('the correct hint works for both token types', async () => {
  const a = grant();
  await revokeGrantByToken(asClient(a), { token: ACCESS, tokenTypeHint: 'access_token' });
  assertGrantIsDead(a);

  const r = grant();
  await revokeGrantByToken(asClient(r), { token: REFRESH, tokenTypeHint: 'refresh_token' });
  assertGrantIsDead(r);
});

test('no hint at all works for both token types', async () => {
  const a = grant();
  await revokeGrantByToken(asClient(a), { token: ACCESS });
  assertGrantIsDead(a);

  const r = grant();
  await revokeGrantByToken(asClient(r), { token: REFRESH, tokenTypeHint: null });
  assertGrantIsDead(r);
});

test('a WRONG hint still revokes: the search extends to the other type', async () => {
  // The old endpoint branched on the hint first and stopped there, so a client
  // that mislabelled its token got a 200 and a live credential.
  const a = grant();
  await revokeGrantByToken(asClient(a), { token: ACCESS, tokenTypeHint: 'refresh_token' });
  assertGrantIsDead(a);

  const r = grant();
  await revokeGrantByToken(asClient(r), { token: REFRESH, tokenTypeHint: 'access_token' });
  assertGrantIsDead(r);
});

test('a token with no recognisable prefix is found in either table', async () => {
  const db = new FakeSupabase();
  db.seed('api_keys', [
    {
      id: KEY_ID,
      workspace_id: WORKSPACE,
      key_prefix: 'legacypf',
      key_hash: hashApiKey('legacy_token_without_our_prefix'),
      deleted_at: null,
    },
  ]);
  db.seed('oauth_refresh_tokens', [
    {
      id: 'cccccccc-0000-4000-8000-000000000009',
      refresh_hash: sha256hex('legacy_token_without_our_prefix'),
      api_key_id: KEY_ID,
      workspace_id: WORKSPACE,
      client_id: 'dyn_1b0c5eda0895e91e59dcc2ac',
      revoked_at: null,
    },
  ]);

  const out = await revokeGrantByToken(asClient(db), {
    token: 'legacy_token_without_our_prefix',
    tokenTypeHint: 'nonsense',
  });

  assert.equal(out.revoked, true);
  assertGrantIsDead(db);
});

test('the lookup order always covers both types, prefix beating hint', () => {
  assert.deepEqual(revocationLookupOrder('mcpr_x'), ['refresh_token', 'access_token']);
  assert.deepEqual(revocationLookupOrder('mcpe_x'), ['access_token', 'refresh_token']);
  // The prefix is a fact about the token; the hint is only a claim.
  assert.deepEqual(revocationLookupOrder('mcpr_x', 'access_token'), [
    'refresh_token',
    'access_token',
  ]);
  assert.deepEqual(revocationLookupOrder('opaque', 'refresh_token'), [
    'refresh_token',
    'access_token',
  ]);
  for (const order of [
    revocationLookupOrder('opaque'),
    revocationLookupOrder('opaque', null),
    revocationLookupOrder('opaque', 'garbage'),
  ]) {
    assert.equal(new Set(order).size, 2, 'both token types must always be searched');
  }
});

/* ── Not an oracle (RFC 7009 §2.2) ───────────────────────────────────────── */

test('an unknown token writes nothing and reports nothing revoked', async () => {
  const db = grant();
  const out = await revokeGrantByToken(asClient(db), { token: 'mcpr_neverissued' });

  assert.equal(out.revoked, false);
  assert.equal(out.matchedAs, null);
  assert.equal(out.apiKeyId, null);
  // The real grant is untouched: a wrong guess must not take somebody else down.
  assert.equal(keys(db)[0].deleted_at, null);
  assert.equal(refreshes(db)[0].revoked_at, null);
});

test('an empty token is a no-op, not a crash', async () => {
  const db = grant();
  const out = await revokeGrantByToken(asClient(db), { token: '' });
  assert.equal(out.revoked, false);
  assert.equal(keys(db)[0].deleted_at, null);
});

test('revoking twice is idempotent and does not move the first timestamp', async () => {
  const db = grant();
  const first = await revokeGrantByToken(asClient(db), {
    token: REFRESH,
    now: new Date('2026-09-09T12:00:00.000Z'),
  });
  assert.equal(first.revoked, true);

  const second = await revokeGrantByToken(asClient(db), {
    token: REFRESH,
    now: new Date('2026-09-09T13:00:00.000Z'),
  });

  // Found, but nothing left to do: indistinguishable from success to the caller,
  // and `deleted_at` still names the moment access actually ended.
  assert.equal(second.revoked, false);
  assert.equal(second.matchedAs, 'refresh_token');
  assert.equal(keys(db)[0].deleted_at, '2026-09-09T12:00:00.000Z');
  assert.equal(refreshes(db)[0].revoked_at, '2026-09-09T12:00:00.000Z');
});

/* ── Grants in odd shapes ────────────────────────────────────────────────── */

test('a half-revoked grant is finished, not skipped', async () => {
  // The exact wreckage the old endpoint left behind: refresh row revoked, key
  // still live. Presenting the refresh token again has to close the other half.
  const db = grant({ refreshRevokedAt: '2026-09-01T00:00:00.000Z' });

  const out = await revokeGrantByToken(asClient(db), { token: REFRESH });

  assert.equal(out.accessTokensRevoked, 1);
  assert.equal(out.refreshTokensRevoked, 0);
  assertGrantIsDead(db);
});

test('a live chain hanging off an already-deleted key is still killed', async () => {
  // The mirror image: key soft-deleted, chain left live.
  const db = grant({ keyDeletedAt: '2026-09-01T00:00:00.000Z' });

  const out = await revokeGrantByToken(asClient(db), { token: ACCESS });

  assert.equal(out.accessTokensRevoked, 0);
  assert.equal(out.refreshTokensRevoked, 1);
  assertGrantIsDead(db);
});

test('a legacy chain with no api_key_id revokes its own row', async () => {
  const db = grant({ apiKeyId: null });

  const out = await revokeGrantByToken(asClient(db), { token: REFRESH });

  assert.equal(out.revoked, true);
  assert.equal(out.apiKeyId, null);
  assert.equal(out.refreshTokensRevoked, 1);
  assert.ok(refreshes(db)[0].revoked_at);
});

/* ── CIMD client ids are URLs, not dyn_ ids ──────────────────────────────── */

test('a grant issued to a CIMD client revokes the same way and logs its URL', async () => {
  const db = grant({ clientId: CIMD_CLIENT });

  const out = await revokeGrantByToken(asClient(db), { token: REFRESH });

  assert.equal(out.revoked, true);
  assert.equal(out.clientId, CIMD_CLIENT);
  assertGrantIsDead(db);
});

test('a client_id for the log is normalised for URLs and passed through for dyn_ ids', () => {
  assert.equal(loggableClientId('dyn_1b0c5eda0895e91e59dcc2ac'), 'dyn_1b0c5eda0895e91e59dcc2ac');
  assert.equal(loggableClientId(CIMD_CLIENT), CIMD_CLIENT);
  // Two spellings of one client must become one line in the log.
  assert.equal(loggableClientId('https://claude.ai:443/api/mcp/cimd'), CIMD_CLIENT);
  // Attacker-controlled free text that cannot be a client_id here is dropped.
  assert.equal(loggableClientId('http://claude.ai/api/mcp/cimd'), null);
  assert.equal(loggableClientId(null), null);
  assert.equal(loggableClientId(''), null);
});
