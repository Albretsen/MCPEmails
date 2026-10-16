// ---------------------------------------------------------------------------
// POST /api/oauth/authorize: the consent POST never mints a code for, or
// returns a redirect_to built from, a script-running redirect_uri, even for a
// client row registered before /api/oauth/register refused those schemes.
//
// Stubbed: the user-scoped and service-role Supabase clients (an in-memory
// oauth_clients, recorded inserts), CSRF, the state nonce and the active
// workspace. Scope, inbox and redirect validation and the redirect_to build run
// for real.
//
// Run: npm run test:oauth-authorize-post (from apps/web).
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;
const clients: Row[] = [];
const inserts: Record<string, Row[]> = {};

function userClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
      b.in = () => b;
      b.not = () => b;
      const rows = () => (table === 'oauth_clients' ? clients : []).filter((r) => filters.every((f) => f(r)));
      b.single = async () => {
        const r = rows()[0];
        return r ? { data: r, error: null } : { data: null, error: { code: 'PGRST116' } };
      };
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      return b;
    },
  };
}

function serviceClient() {
  return {
    from(table: string) {
      const record = (row: Row) => {
        (inserts[table] ??= []).push(row);
        return Promise.resolve({ data: null, error: null });
      };
      return { insert: record, upsert: record };
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => userClient() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: serviceClient } });
nodeMock.module('@/lib/oauth/csrf', { namedExports: { validateCsrfToken: async () => true } });
nodeMock.module('@/lib/oauth/state', { namedExports: { consumeStateNonce: async () => true } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'w1' } });

const { POST } = await import('./route.ts');

function consent(over: Row = {}) {
  return POST(
    new Request('https://mcpemails.test/api/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        csrf_token: 'csrf',
        client_id: 'dyn_legacy',
        redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
        state: 'st',
        code_challenge: 'cc',
        challenge_method: 'S256',
        scopes: ['read:email'],
        all_inboxes: true,
        inbox_ids: null,
        ...over,
      }),
    }) as never,
  );
}

const LEGACY_EVIL = "javascript:fetch('/api/api-keys',{method:'POST'})//";

test.beforeEach(() => {
  for (const k of Object.keys(inserts)) delete inserts[k];
  clients.length = 0;
  clients.push({
    client_id: 'dyn_legacy',
    client_name: 'Cursor',
    redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', LEGACY_EVIL, 'data:text/html,<script>1</script>', 'https://claude.ai/api/mcp/auth_callback'],
    scopes_allowed: ['read:email', 'search:email'],
    deactivated_at: null,
  });
});

for (const uri of [LEGACY_EVIL, 'data:text/html,<script>1</script>']) {
  test(`a registered ${uri.split(':')[0]}: redirect is refused before any code is minted`, async () => {
    const res = await consent({ redirect_uri: uri });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.redirect_to, undefined);
    assert.equal(inserts.oauth_auth_codes, undefined, 'no authorization code written');
    assert.equal(inserts.oauth_consents, undefined, 'no consent recorded');
  });
}

test('LEGIT: a native-app redirect gets its code', async () => {
  const res = await consent();
  assert.equal(res.status, 200);
  const { redirect_to } = await res.json();
  const url = new URL(redirect_to);
  assert.equal(url.protocol, 'cursor:');
  assert.match(url.searchParams.get('code') ?? '', /^[0-9a-f]{64}$/);
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(inserts.oauth_auth_codes.length, 1);
});

test('LEGIT: an https redirect gets its code', async () => {
  const res = await consent({ redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.equal(res.status, 200);
  const { redirect_to } = await res.json();
  assert.ok(redirect_to.startsWith('https://claude.ai/api/mcp/auth_callback?code='));
});

test('an unregistered redirect is still refused', async () => {
  const res = await consent({ redirect_uri: 'https://attacker.example/cb' });
  assert.equal(res.status, 400);
  assert.equal(inserts.oauth_auth_codes, undefined);
});
