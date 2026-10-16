// ---------------------------------------------------------------------------
// POST /api/oauth/authorize caps the grant to the caller's workspace role.
//
// The consent POST used to check membership only, so a viewer (read-only
// everywhere else) could consent to send:email, delete:email and
// manage:automations and walk away with a working write key. These tests pin
// the cap on the written oauth_auth_codes row and the consent row, the clear
// refusal when nothing read-only is left, and that owner/admin/member consent
// is exactly what it was.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/oauth/authorize/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: 'user-1', email: 'person@example.test' };
const WS = 'ws-team';
const CLIENT = 'dyn_testclient';
const REDIRECT = 'https://client.example.test/callback';
const ALL = [
  'read:email', 'search:email', 'send:email', 'manage:folders', 'delete:email',
  'manage:drafts', 'manage:contacts', 'schedule:email', 'manage:automations',
];

let db: FakeSupabase;
let activeWorkspace: string | null;

function reset(role: string | null): void {
  db = new FakeSupabase();
  activeWorkspace = WS;
  db.seed('oauth_clients', [{
    client_id: CLIENT, client_name: 'Test Client', redirect_uris: [REDIRECT], scopes_allowed: ALL, deactivated_at: null,
  }]);
  if (role) db.seed('workspace_members', [{ workspace_id: WS, user_id: USER.id, role }]);
}

// Upsert in the shared fake enforces the billing table's unique index; consent
// rows only need to be recorded here.
const userClient = () => ({
  auth: { getUser: async () => ({ data: { user: USER }, error: null }) },
  from: (t: string) => db.from(t),
});
const serviceClient = () => ({
  from: (t: string) => {
    const q = db.from(t);
    return {
      ...q,
      upsert: async (row: Record<string, unknown>) => {
        db.table(t).push(row);
        return { data: null, error: null };
      },
    };
  },
});

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => userClient() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => serviceClient() } });
nodeMock.module('@/lib/oauth/csrf', { namedExports: { validateCsrfToken: async () => true } });
nodeMock.module('@/lib/oauth/state', { namedExports: { consumeStateNonce: async () => true } });
nodeMock.module('@/lib/workspace/active', {
  namedExports: { resolveActiveWorkspaceId: async () => activeWorkspace },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const { POST } = (await import('./route.ts')) as unknown as { POST: (req: Request) => Promise<Response> };

function consent(scopes: string[], extra: Record<string, unknown> = {}): Request {
  return new Request('https://mcpemails.test/api/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      csrf_token: 'csrf', client_id: CLIENT, redirect_uri: REDIRECT, state: 's',
      code_challenge: 'challenge', challenge_method: 'S256', scopes, all_inboxes: true, ...extra,
    }),
  });
}

const codeScopes = () => db.table('oauth_auth_codes').map((r) => r.scopes);
const consentScopes = () => db.table('oauth_consents').map((r) => r.scopes);

beforeEach(() => reset('owner'));

test('owner: every requested scope is granted, unchanged', async () => {
  const res = await POST(consent(ALL, { identity_scopes: ['openid'] }));
  assert.equal(res.status, 200);
  const { redirect_to } = await res.json() as { redirect_to: string };
  assert.ok(redirect_to.startsWith(`${REDIRECT}?code=`));
  assert.deepEqual(codeScopes(), [[...ALL, 'openid']]);
  assert.deepEqual(consentScopes(), [[...ALL, 'openid']]);
});

test('admin and member: every requested scope is granted', async () => {
  for (const role of ['admin', 'member']) {
    reset(role);
    const res = await POST(consent(['read:email', 'send:email', 'manage:automations']));
    assert.equal(res.status, 200, role);
    assert.deepEqual(codeScopes(), [['read:email', 'send:email', 'manage:automations']], role);
  }
});

test('viewer: write scopes are dropped from the code and the consent record', async () => {
  reset('viewer');
  const res = await POST(consent(ALL, { identity_scopes: ['openid', 'email'] }));
  assert.equal(res.status, 200);
  assert.deepEqual(codeScopes(), [['read:email', 'search:email', 'openid', 'email']]);
  assert.deepEqual(consentScopes(), [['read:email', 'search:email', 'openid', 'email']]);
});

test('viewer: asking only for write scopes is refused with a clear 403 and writes nothing', async () => {
  reset('viewer');
  const res = await POST(consent(['send:email', 'delete:email', 'manage:automations'], { identity_scopes: ['openid'] }));
  assert.equal(res.status, 403);
  const body = await res.json() as { error: string; error_code: string };
  assert.equal(body.error_code, 'insufficient_role');
  assert.match(body.error, /viewer/);
  assert.match(body.error, /read:email/);
  assert.equal(db.table('oauth_auth_codes').length, 0);
  assert.equal(db.table('oauth_consents').length, 0);
});

test('not a member of the resolved workspace: refused, nothing written', async () => {
  reset(null);
  const res = await POST(consent(['read:email']));
  assert.equal(res.status, 400);
  assert.equal(db.table('oauth_auth_codes').length, 0);
});

test('a role lookup error is a 500, never a silent full grant', async () => {
  reset('viewer');
  db.failOnce('workspace_members', { message: 'connection reset' });
  const res = await POST(consent(ALL));
  assert.equal(res.status, 500);
  assert.equal(db.table('oauth_auth_codes').length, 0);
});

// ── Independent verification ────────────────────────────────────────────────

test('verify: the role is read for the ACTIVE workspace, not the caller\'s best role elsewhere', async () => {
  reset('viewer');
  db.seed('workspace_members', [{ workspace_id: 'ws-own', user_id: USER.id, role: 'owner' }]);
  const res = await POST(consent(['read:email', 'send:email']));
  assert.equal(res.status, 200);
  assert.deepEqual(codeScopes(), [['read:email']]);
  assert.equal(db.table('oauth_auth_codes')[0].workspace_id, WS);
});

test('verify: owner in the active workspace keeps full scopes even if a viewer elsewhere', async () => {
  reset('owner');
  db.seed('workspace_members', [{ workspace_id: 'ws-other', user_id: USER.id, role: 'viewer' }]);
  const res = await POST(consent(['read:email', 'send:email', 'manage:automations']));
  assert.equal(res.status, 200);
  assert.deepEqual(codeScopes(), [['read:email', 'send:email', 'manage:automations']]);
});

test('verify: a viewer cannot smuggle write or identity scopes through the scopes array', async () => {
  reset('viewer');
  const res = await POST(consent(['openid', 'email', 'send:email', 'SEND:EMAIL', ' send:email'], { identity_scopes: ['openid', 'send:email'] }));
  assert.equal(res.status, 403);
  assert.equal(db.table('oauth_auth_codes').length, 0);
});
