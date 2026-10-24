// ---------------------------------------------------------------------------
// The failure JSON of the two password connect routes carries what the connect
// panel needs to pick its fix row (lib/email/auth-failure-help.ts connectFix):
// `host`, `phase`, `via_relay`, `relay_failed`, and `imap_ok` on a sending
// failure. Never the address and never the password.
//
// Only I/O is stubbed: Supabase, the mail validators and the transport loops.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/inboxes/connect-failure-shape.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-0000000000a1', email: 'op@example.test' };
const WS = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'person@example.test';
const SECRET = 'Sup3r-Secret!';

type Outcome = { ok: true } | { ok: false; code: string; phase: string; message: string; detail?: string };

interface World {
  imap: Outcome;
  smtp: Outcome;
  imapRoute: string | null;
  imapRelayAlsoFailed: boolean;
}
let world: World;

const OK: Outcome = { ok: true };
beforeEach(() => {
  world = { imap: OK, smtp: OK, imapRoute: null, imapRelayAlsoFailed: false };
});

function client() {
  return {
    from() {
      return { upsert: async () => ({ error: null }) };
    },
    auth: { getUser: async () => ({ data: { user: USER }, error: null }) },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => client() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client() } });
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
    after: () => {},
  },
});
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => WS } });
nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => 'owner',
    canManageInboxes: () => true,
    insufficientRoleBody: (error: string) => ({ error, error_code: 'insufficient_role' }),
  },
});
nodeMock.module('@/lib/crypto', { namedExports: { encryptToken: (v: string) => `enc:${v}` } });
nodeMock.module('@/lib/plans/check-inbox-limit', {
  namedExports: {
    inboxExistsForEmail: async () => false,
    checkInboxLimit: async () => ({ atLimit: false, plan: 'pro', currentCount: 0, maxInboxes: null }),
    inboxLimitErrorBody: () => ({ error: 'limit', error_code: 'inbox_limit_reached' }),
  },
});
nodeMock.module('@/lib/plans/inbox-cap-events', { namedExports: { recordInboxCapHit: async () => {} } });
nodeMock.module('@/lib/stripe/mailbox-addon', { namedExports: { syncMailboxAddonForWorkspace: async () => {} } });
nodeMock.module('@/lib/inboxes/provider-conflict', {
  namedExports: { findOtherProviderInbox: async () => ({ conflict: false }), otherProviderErrorBody: () => ({}) },
});
nodeMock.module('@/lib/email/validate-imap', { namedExports: { validateImapCredential: async () => world.imap } });
nodeMock.module('@/lib/email/validate-smtp', { namedExports: { validateSmtpCredential: async () => world.smtp } });
nodeMock.module('@/lib/email/mail-relay', { namedExports: { mailRelayConfigFromEnv: () => null } });
nodeMock.module('@/lib/email/relay-fallback', {
  namedExports: {
    refreshLearnedRelayHosts: async () => {},
    detectWithRelay: async (opts: { protocol: string; requested: { port: number; security: string } }) => {
      const imap = opts.protocol === 'imap';
      return {
        detection: { result: imap ? world.imap : world.smtp, candidate: opts.requested, adjusted: false, attempts: 1 },
        route: imap ? world.imapRoute : null,
        ...(imap && world.imapRelayAlsoFailed ? { relayAlsoFailed: true } : {}),
      };
    },
  },
});
nodeMock.module('@/lib/email/transport-autodetect', {
  namedExports: {
    transportPlan: (_p: string, requested: unknown) => [requested],
    detectTransport: async (plan: Array<{ port: number; security: string }>, attempt: (c: unknown, t: number) => Promise<Outcome>) => {
      const result = await attempt(plan[0], 1000);
      return { result, candidate: plan[0], adjusted: false, attempts: 1 };
    },
  },
});
nodeMock.module('@/lib/email/host-guard', {
  namedExports: { guardMailHost: async () => ({ ok: true, address: '192.0.2.10' }) },
});
nodeMock.module('@/lib/email/imap-login-collision', {
  namedExports: { findConflictingInbox: async () => ({ conflict: false }) },
});
nodeMock.module('@/lib/errors/capture', { namedExports: { captureError: async () => {} } });
nodeMock.module('@/lib/analytics/product-funnel', { namedExports: { recordProductFunnelEvent: async () => {} } });

const { POST: imapPOST } = await import('./imap/route.ts');
const { POST: appPasswordPOST } = await import('./app-password/route.ts');

function post(handler: (req: never) => Promise<Response>, path: string, body: Record<string, unknown>) {
  return handler(
    new Request(`https://mcpemails.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );
}

const GENERIC = {
  email: ADDRESS,
  appPassword: SECRET,
  mode: 'both',
  imapHost: 'Mail.Example.test',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: 'smtp.example.test',
  smtpPort: 465,
  smtpSecurity: 'tls',
};

/** Nothing identifying in the body, whatever the failure. */
function assertNoSecrets(body: Record<string, unknown>) {
  const text = JSON.stringify(body);
  assert.equal(text.includes(SECRET), false, 'the password is never returned');
  assert.equal(text.toLowerCase().includes(ADDRESS), false, 'the address is never returned');
  assert.equal(text.includes('person@'), false);
}

test('imap route: a server that never answered names the host, the phase and the relay', async () => {
  world.imap = { ok: false, code: 'CONNECTION_TIMEOUT', phase: 'tcp', message: 'timed out' };
  world.imapRoute = null;
  world.imapRelayAlsoFailed = true;
  const res = await post(imapPOST, '/api/inboxes/imap', GENERIC);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error_code, 'connection_timeout');
  assert.equal(body.host, 'mail.example.test');
  assert.equal(body.phase, 'tcp');
  assert.equal(body.via_relay, false);
  assert.equal(body.relay_failed, true);
  assert.equal('imap_ok' in body, false, 'imap_ok is only on a sending failure');
  assertNoSecrets(body);
});

test('imap route: a rejected login carries the reason and the authentication phase', async () => {
  world.imap = { ok: false, code: 'AUTH_FAILED', phase: 'authentication', message: 'rejected', detail: 'NO [AUTHENTICATIONFAILED] Invalid credentials' };
  world.imapRoute = 'fallback';
  const res = await post(imapPOST, '/api/inboxes/imap', GENERIC);
  const body = await res.json();
  assert.equal(body.error_code, 'auth_failed');
  assert.equal(body.auth_reason, 'password_rejected');
  assert.equal(body.phase, 'authentication');
  assert.equal(body.via_relay, true);
  assert.equal(body.relay_failed, false);
  assertNoSecrets(body);
});

test('imap route: sending refused after the login passed says imap_ok and the smtp phase', async () => {
  world.smtp = { ok: false, code: 'AUTH_FAILED', phase: 'authentication', message: 'rejected', detail: '535 5.7.8 authentication failed' };
  const res = await post(imapPOST, '/api/inboxes/imap', GENERIC);
  const body = await res.json();
  assert.equal(body.error_code, 'auth_failed');
  assert.equal(body.phase, 'smtp_authentication');
  assert.equal(body.host, 'smtp.example.test');
  assert.equal(body.imap_ok, true);
  assert.equal(body.via_relay, false);
  assertNoSecrets(body);
});

test('imap route: a send-only connection never claims the IMAP half passed', async () => {
  world.smtp = { ok: false, code: 'CONNECTION_REFUSED', phase: 'tcp', message: 'refused' };
  const { imapHost: _h, imapPort: _p, imapSecurity: _s, ...sendOnly } = GENERIC;
  const res = await post(imapPOST, '/api/inboxes/imap', { ...sendOnly, mode: 'smtp' });
  const body = await res.json();
  assert.equal(body.phase, 'smtp_tcp');
  assert.equal(body.imap_ok, false);
});

test('app-password route: a rejected Yahoo login carries host, phase and no relay', async () => {
  world.imap = { ok: false, code: 'AUTH_FAILED', phase: 'authentication', message: 'rejected', detail: 'NO [AUTHENTICATIONFAILED] Incorrect username or password.' };
  const res = await post(appPasswordPOST, '/api/inboxes/app-password', { service: 'yahoo', email: 'someone@yahoo.com', appPassword: 'MyNormalPassword1' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error_code, 'auth_failed');
  assert.equal(body.auth_reason, 'account_password_used');
  assert.equal(body.host, 'imap.mail.yahoo.com');
  assert.equal(body.phase, 'authentication');
  assert.equal(body.via_relay, false);
  assert.equal(body.relay_failed, false);
  assert.equal(JSON.stringify(body).includes('someone@yahoo.com'), false);
  assert.equal(JSON.stringify(body).includes('MyNormalPassword1'), false);
});

test('app-password route: a sending failure says imap_ok and the smtp phase', async () => {
  world.smtp = { ok: false, code: 'TLS_HANDSHAKE_FAILED', phase: 'tls', message: 'tls' };
  const res = await post(appPasswordPOST, '/api/inboxes/app-password', { service: 'gmail', email: 'someone@gmail.com', appPassword: 'abcdabcdabcdabcd' });
  const body = await res.json();
  assert.equal(body.error_code, 'tls_handshake_failed');
  assert.equal(body.phase, 'smtp_tls');
  assert.equal(body.host, 'smtp.gmail.com');
  assert.equal(body.imap_ok, true);
});
