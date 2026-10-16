// ---------------------------------------------------------------------------
// POST /api/inboxes/[id]/check and DELETE /api/inboxes/[id]: role gate and
// which Supabase client touches what.
//
// Migration 20261016160200 took every write on public.inboxes away from the
// `authenticated` role and hid the three encrypted credential columns from it.
// Both routes used to read those columns, and the check route also wrote the
// inbox status, through the USER-scoped client, and the check route ran for a
// viewer. These tests pin the new shape:
//
//   - the user-scoped client only ever SELECTs non-secret columns of inboxes,
//     and never writes inboxes;
//   - a viewer gets 403 insufficient_role before any credential is read,
//     decrypted or dialled;
//   - an operator (owner/admin/member) still gets the full check / disconnect,
//     with the credential read and the status write on the service-role
//     client, scoped to the authorized id AND workspace.
//
// Only I/O is stubbed. Every Supabase call lands in one ordered log.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/inboxes/inbox-routes.roles.test.ts
// (Outside [id]/ because node --test reads its arguments as globs, and `[id]`
// is a character class.)
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-0000000000a1', email: 'op@example.test' };
const WS = '11111111-1111-4111-8111-111111111111';
const INBOX = '22222222-2222-4222-8222-222222222222';
const SECRET_COLUMNS = ['imap_password', 'oauth_access_token', 'oauth_refresh_token'];

interface Call {
  client: 'user' | 'service';
  table: string;
  op: 'select' | 'update' | 'insert' | 'upsert' | 'delete';
  columns: string | null;
  filters: Array<[string, string, unknown]>;
  payload: unknown;
}

interface World {
  role: string | null;
  /** The row as the service role sees it (secrets included). */
  row: Record<string, unknown> | null;
  /** Whether the user's RLS SELECT returns the row. */
  visible: boolean;
  calls: Call[];
  imapLogins: Array<{ host: string; appPassword: string }>;
  fetches: string[];
  /** What the stubbed Gmail probe answers. */
  gmailOk: boolean;
}

let world: World;

function appPasswordRow(): Record<string, unknown> {
  return {
    id: INBOX,
    workspace_id: WS,
    provider: 'imap',
    email_address: 'box@example.test',
    imap_host: 'imap.example.test',
    imap_port: 993,
    smtp_host: 'smtp.example.test',
    smtp_port: 465,
    imap_username: null,
    imap_password: 'enc:app-password',
    oauth_access_token: null,
    oauth_refresh_token: null,
    status: 'error',
    last_error: 'old',
    deleted_at: null,
  };
}

function gmailRow(): Record<string, unknown> {
  return {
    ...appPasswordRow(),
    provider: 'gmail',
    imap_host: null,
    smtp_host: null,
    imap_password: null,
    oauth_access_token: 'enc:access',
    oauth_refresh_token: 'enc:refresh',
  };
}

function reset(overrides: Partial<World> = {}): void {
  world = {
    role: 'member',
    row: appPasswordRow(),
    visible: true,
    calls: [],
    imapLogins: [],
    fetches: [],
    gmailOk: true,
    ...overrides,
  };
}

function pick(row: Record<string, unknown>, columns: string | null): Record<string, unknown> {
  if (!columns || columns.trim() === '*') return { ...row };
  const out: Record<string, unknown> = {};
  for (const c of columns.split(',').map((s) => s.trim())) out[c] = row[c];
  return out;
}

function resolve(call: Call): { data: unknown; error: unknown } {
  if (call.table === 'workspace_members' && call.op === 'select') {
    return world.role ? { data: { role: world.role }, error: null } : { data: null, error: null };
  }
  if (call.table === 'inboxes' && call.op === 'select') {
    if (!world.row) return { data: null, error: { message: 'not found' } };
    if (call.client === 'user') {
      // The column grant from 20261016160200: authenticated cannot read these.
      const cols = (call.columns ?? '*').split(',').map((s) => s.trim());
      if (cols.includes('*') || cols.some((c) => SECRET_COLUMNS.includes(c))) {
        return { data: null, error: { code: '42501', message: 'permission denied for table inboxes' } };
      }
      if (!world.visible) return { data: null, error: { message: 'no rows' } };
    }
    return { data: pick(world.row, call.columns), error: null };
  }
  if (call.table === 'inboxes' && call.client === 'user') {
    // authenticated has no INSERT/UPDATE/DELETE on inboxes any more.
    return { data: null, error: { code: '42501', message: 'permission denied for table inboxes' } };
  }
  if (call.table === 'workspaces' && call.op === 'update') return { data: [], error: null };
  return { data: null, error: null };
}

function client(kind: 'user' | 'service') {
  return {
    from(table: string) {
      const call: Call = { client: kind, table, op: 'select', columns: null, filters: [], payload: null };
      let logged = false;
      const run = () => {
        if (!logged) {
          world.calls.push(call);
          logged = true;
        }
        return resolve(call);
      };
      const builder: Record<string, unknown> = {};
      builder.select = (columns?: string) => {
        if (call.op === 'select') call.columns = columns ?? '*';
        return builder;
      };
      for (const op of ['update', 'insert', 'upsert', 'delete'] as const) {
        builder[op] = (payload?: unknown) => {
          call.op = op;
          call.payload = payload ?? null;
          return builder;
        };
      }
      for (const f of ['eq', 'is', 'in', 'neq', 'order', 'range', 'limit']) {
        builder[f] = (col: string, val: unknown) => {
          call.filters.push([f, col, val]);
          return builder;
        };
      }
      builder.single = async () => run();
      builder.maybeSingle = async () => run();
      builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(ok, ko);
      return builder;
    },
    auth: {
      getUser: async () => ({ data: { user: USER }, error: null }),
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => client('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client('service') } });
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});
nodeMock.module('@/lib/crypto', {
  namedExports: { decryptToken: (v: string) => `plain(${v})`, encryptToken: (v: string) => `enc:${v}` },
});

class StubError extends Error {
  code?: string;
}
nodeMock.module('@/lib/email/imap', {
  namedExports: {
    openImapSession: async (opts: { host: string; appPassword: string }) => {
      world.imapLogins.push({ host: opts.host, appPassword: opts.appPassword });
      return { logout: async () => {} };
    },
    McpEmailsError: StubError,
    ImapAuthError: class extends StubError {},
  },
});
nodeMock.module('@/lib/email/host-guard', {
  namedExports: { guardMailHost: async () => ({ ok: true, address: '192.0.2.10' }) },
});
nodeMock.module('@/lib/email-providers/gmail', {
  namedExports: {
    withFreshGmailToken: async () => 'token',
    verifyGmailAccess: async () => world.gmailOk,
    InboxAuthError: class extends StubError {},
  },
});
nodeMock.module('@/lib/email-providers/outlook', {
  namedExports: { checkOutlookMailbox: async () => 'ok', OutlookAuthError: class extends StubError {} },
});
nodeMock.module('@/lib/email-providers/outlook-oauth', {
  namedExports: { OUTLOOK_NO_MAILBOX_REASON: 'no mailbox' },
});
nodeMock.module('@/lib/email/validate-smtp', {
  namedExports: { validateSmtpCredential: async () => ({ ok: true }) },
});
nodeMock.module('@/lib/email/mail-relay', {
  namedExports: {
    mailRelayConfigFromEnv: () => null,
    MailRelayTargetRefusedError: class extends StubError {},
    MailRelayUnavailableError: class extends StubError {},
    openMailRelayTunnel: async () => {
      throw new Error('not used');
    },
  },
});
nodeMock.module('@/lib/email/relay-fallback', {
  namedExports: {
    describeDirectFailure: () => null,
    learnRelayHost: async () => {},
    RELAYED_TRANSPORTS: { smtp: { port: 465, security: 'tls' } },
    recordRelayUse: async () => {},
    refreshLearnedRelayHosts: async () => {},
    relayRouteForHost: () => false,
    shouldTryRelayAfter: () => false,
  },
});
nodeMock.module('@/lib/analytics/product-funnel', {
  namedExports: { recordProductFunnelEvent: async () => {} },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  world.fetches.push(String(input));
  return new Response(null, { status: 200 });
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const checkRoute = await import('./[id]/check/route.ts');
const inboxRoute = await import('./[id]/route.ts');

const params = { params: Promise.resolve({ id: INBOX }) };
const post = () =>
  checkRoute.POST(new Request(`https://mcpemails.test/api/inboxes/${INBOX}/check`, { method: 'POST' }) as never, params);
const del = () =>
  inboxRoute.DELETE(new Request(`https://mcpemails.test/api/inboxes/${INBOX}`, { method: 'DELETE' }) as never, params);

const inboxCalls = (kind: 'user' | 'service') =>
  world.calls.filter((c) => c.client === kind && c.table === 'inboxes');

/** The invariant both routes must keep under the new grants. */
function assertUserClientNeverTouchesSecretsOrWrites(): void {
  for (const c of inboxCalls('user')) {
    assert.equal(c.op, 'select', `user client must not ${c.op} inboxes`);
    const cols = (c.columns ?? '*').split(',').map((s) => s.trim());
    assert.ok(!cols.includes('*'), `user client must not select * from inboxes (${c.columns})`);
    for (const secret of SECRET_COLUMNS) {
      assert.ok(!cols.includes(secret), `user client must not select ${secret}`);
    }
  }
}

function assertScopedToAuthorizedInbox(c: Call): void {
  assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'id' && v === INBOX), 'scoped to the inbox id');
  assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'workspace_id' && v === WS), 'scoped to its workspace');
}

beforeEach(() => reset());

// ── POST /api/inboxes/[id]/check ───────────────────────────────────────────

test('check: a viewer gets 403 insufficient_role and nothing is read, decrypted or dialled', async () => {
  reset({ role: 'viewer' });
  const res = await post();
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error_code, 'insufficient_role');
  assert.equal(inboxCalls('service').length, 0, 'no service-role read of the credentials');
  assert.equal(world.imapLogins.length, 0, 'no login attempt');
  assertUserClientNeverTouchesSecretsOrWrites();
});

test('check: a caller with no membership row is refused like a viewer', async () => {
  reset({ role: null });
  const res = await post();
  assert.equal(res.status, 403);
  assert.equal(world.imapLogins.length, 0);
});

test('check: an inbox the caller cannot see is 404 before any role or credential lookup', async () => {
  reset({ visible: false });
  const res = await post();
  assert.equal(res.status, 404);
  assert.equal(inboxCalls('service').length, 0);
  assert.equal(world.calls.filter((c) => c.table === 'workspace_members').length, 0);
});

for (const role of ['owner', 'admin', 'member']) {
  test(`check: ${role} still runs the check; credentials and status write go through the service role`, async () => {
    reset({ role });
    const res = await post();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'active');

    assert.deepEqual(world.imapLogins, [{ host: 'imap.example.test', appPassword: 'plain(enc:app-password)' }]);

    const serviceRead = inboxCalls('service').find((c) => c.op === 'select');
    assert.ok(serviceRead, 'the full row is read with the service role');
    assertScopedToAuthorizedInbox(serviceRead);

    const write = inboxCalls('service').find((c) => c.op === 'update');
    assert.ok(write, 'the status write uses the service role');
    assertScopedToAuthorizedInbox(write);
    assert.equal((write.payload as Record<string, unknown>).status, 'active');

    assertUserClientNeverTouchesSecretsOrWrites();
  });
}

test('check: a rejected sign-in is persisted as error through the service role', async () => {
  reset({ role: 'member', row: gmailRow(), gmailOk: false });
  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'error');
  const write = inboxCalls('service').find((c) => c.op === 'update');
  assert.ok(write, 'the error status is written with the service role');
  assertScopedToAuthorizedInbox(write);
  assert.equal((write.payload as Record<string, unknown>).status, 'error');
  assertUserClientNeverTouchesSecretsOrWrites();
});

// ── DELETE /api/inboxes/[id] ───────────────────────────────────────────────

test('disconnect: a viewer gets 403 and no token is read or revoked', async () => {
  reset({ role: 'viewer', row: gmailRow() });
  const res = await del();
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error_code, 'insufficient_role');
  assert.equal(inboxCalls('service').length, 0);
  assert.equal(world.fetches.length, 0);
  assertUserClientNeverTouchesSecretsOrWrites();
});

test('disconnect: a member disconnecting Gmail still revokes the grant, tokens read by the service role', async () => {
  reset({ role: 'member', row: gmailRow() });
  const res = await del();
  assert.equal(res.status, 200);

  const tokenRead = inboxCalls('service').find((c) => c.op === 'select');
  assert.ok(tokenRead, 'tokens are read with the service role');
  assertScopedToAuthorizedInbox(tokenRead);
  assert.ok(tokenRead.columns?.includes('oauth_refresh_token'));

  assert.equal(world.fetches.length, 1);
  assert.ok(
    world.fetches[0].startsWith('https://oauth2.googleapis.com/revoke?token=') &&
      world.fetches[0].includes(encodeURIComponent('plain(enc:refresh)')),
    'the refresh token is the one revoked',
  );

  const write = inboxCalls('service').find((c) => c.op === 'update');
  assert.ok(write);
  assertScopedToAuthorizedInbox(write);
  const payload = write.payload as Record<string, unknown>;
  assert.equal(payload.status, 'revoked');
  assert.equal(payload.imap_password, null);
  assert.equal(payload.oauth_refresh_token, null);

  assertUserClientNeverTouchesSecretsOrWrites();
});

test('disconnect: an app-password inbox has nothing to revoke and reads no tokens', async () => {
  reset({ role: 'owner' });
  const res = await del();
  assert.equal(res.status, 200);
  assert.equal(inboxCalls('service').filter((c) => c.op === 'select').length, 0);
  assert.equal(world.fetches.length, 0);
  assert.ok(inboxCalls('service').some((c) => c.op === 'update'));
  assertUserClientNeverTouchesSecretsOrWrites();
});
