// ---------------------------------------------------------------------------
// POST /api/inboxes/imap: a reconnect that changes the connection type.
//
// The Reconnect dialog lets a generic IMAP/SMTP inbox switch between 'both',
// 'imap' (receive only) and 'smtp' (send only) without disconnecting. That is
// only safe if the route treats it as a reconnect of the SAME row:
//
//   - the plan inbox cap is not consulted (a Free workspace at 1/1 must be
//     able to add sending to the inbox it already has);
//   - only the halves the NEW mode names are dialled;
//   - the write is an upsert on (workspace_id, email_address) with no id of
//     its own, so the existing row, and every id that points at it, survives;
//   - the half the new mode leaves out is written as NULL host and port.
//
// Only I/O is stubbed: Supabase, the mail validators and the relay loop.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/inboxes/imap-reconnect-mode.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-0000000000a1', email: 'op@example.test' };
const WS = '11111111-1111-4111-8111-111111111111';
const INBOX_ID = '22222222-2222-4222-8222-222222222222';
const ADDRESS = 'box@example.test';

interface World {
  /** The stored inboxes table, keyed by `${workspace_id}|${email_address}`. */
  rows: Map<string, Record<string, unknown>>;
  upserts: Array<{ payload: Record<string, unknown>; onConflict: string | undefined }>;
  dialled: string[];
  limitChecks: number;
}

let world: World;

function storedRow(mode: 'both' | 'imap' | 'smtp'): Record<string, unknown> {
  return {
    id: INBOX_ID,
    workspace_id: WS,
    provider: 'imap',
    service: 'generic',
    email_address: ADDRESS,
    imap_host: mode === 'smtp' ? null : 'imap.example.test',
    imap_port: mode === 'smtp' ? null : 993,
    smtp_host: mode === 'imap' ? null : 'smtp.example.test',
    smtp_port: mode === 'imap' ? null : 465,
    deleted_at: null,
  };
}

function reset(mode: 'both' | 'imap' | 'smtp'): void {
  world = {
    rows: new Map([[`${WS}|${ADDRESS}`, storedRow(mode)]]),
    upserts: [],
    dialled: [],
    limitChecks: 0,
  };
}

/** Enough of PostgREST's upsert to show which row the write lands on. */
function upsert(payload: Record<string, unknown>, opts?: { onConflict?: string }) {
  world.upserts.push({ payload, onConflict: opts?.onConflict });
  const keys = (opts?.onConflict ?? 'id').split(',').map((k) => k.trim());
  const match = [...world.rows.values()].find((row) => keys.every((k) => row[k] === payload[k]));
  if (match) Object.assign(match, payload);
  else world.rows.set(`${payload.workspace_id}|${payload.email_address}`, { id: 'new-row', ...payload });
  return Promise.resolve({ error: null });
}

function client() {
  return {
    from(table: string) {
      assert.equal(table, 'inboxes', `unexpected table ${table}`);
      return { upsert };
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
    inboxExistsForEmail: async (_s: unknown, ws: string, email: string) => world.rows.has(`${ws}|${email}`),
    checkInboxLimit: async () => {
      world.limitChecks += 1;
      // A Free workspace at its cap: a brand-new address would be refused.
      return { atLimit: true, plan: 'free', currentCount: 1, maxInboxes: 1 };
    },
    inboxLimitErrorBody: () => ({ error: 'limit', error_code: 'inbox_limit_reached' }),
  },
});
nodeMock.module('@/lib/plans/inbox-cap-events', { namedExports: { recordInboxCapHit: async () => {} } });
nodeMock.module('@/lib/stripe/mailbox-addon', { namedExports: { syncMailboxAddonForWorkspace: async () => {} } });
nodeMock.module('@/lib/inboxes/provider-conflict', {
  namedExports: {
    findOtherProviderInbox: async () => ({ conflict: false }),
    otherProviderErrorBody: () => ({}),
  },
});
nodeMock.module('@/lib/email/validate-imap', { namedExports: { validateImapCredential: async () => ({ ok: true }) } });
nodeMock.module('@/lib/email/validate-smtp', { namedExports: { validateSmtpCredential: async () => ({ ok: true }) } });
nodeMock.module('@/lib/email/mail-relay', { namedExports: { mailRelayConfigFromEnv: () => null } });
nodeMock.module('@/lib/email/relay-fallback', {
  namedExports: {
    refreshLearnedRelayHosts: async () => {},
    detectWithRelay: async (opts: { protocol: string; host: string; requested: { port: number; security: string } }) => {
      world.dialled.push(`${opts.protocol}:${opts.host}`);
      return {
        detection: { result: { ok: true }, candidate: opts.requested, adjusted: false, attempts: [] },
        route: null,
      };
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

const { POST } = await import('./imap/route.ts');

function connect(body: Record<string, unknown>) {
  return POST(
    new Request('https://mcpemails.test/api/inboxes/imap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADDRESS, appPassword: 'app-password', ...body }),
    }) as never,
  );
}

const IMAP = { imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls' };
const SMTP = { smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls' };
const stored = () => world.rows.get(`${WS}|${ADDRESS}`)!;

function assertSameRow(): void {
  assert.equal(world.rows.size, 1, 'no second row');
  assert.equal(stored().id, INBOX_ID, 'the inbox keeps its id');
  for (const { payload, onConflict } of world.upserts) {
    assert.equal(onConflict, 'workspace_id, email_address');
    assert.equal('id' in payload, false, 'the write never names an id of its own');
  }
}

beforeEach(() => reset('both'));

test('receive only to both, at the Free cap: adds SMTP to the same row', async () => {
  reset('imap');
  const res = await connect({ mode: 'both', ...IMAP, ...SMTP });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(world.limitChecks, 0, 'the plan cap is not consulted for an existing address');
  assert.deepEqual(world.dialled, ['imap:imap.example.test', 'smtp:smtp.example.test']);
  assertSameRow();
  assert.equal(stored().smtp_host, 'smtp.example.test');
  assert.equal(stored().smtp_port, 465);
  assert.equal(stored().imap_host, 'imap.example.test');
});

test('both to receive only: SMTP is not dialled and is cleared on the same row', async () => {
  const res = await connect({ mode: 'imap', ...IMAP, ...SMTP });
  assert.equal(res.status, 200);
  assert.deepEqual(world.dialled, ['imap:imap.example.test'], 'only the half the new mode names');
  assertSameRow();
  assert.equal(stored().smtp_host, null);
  assert.equal(stored().smtp_port, null);
  assert.equal(stored().imap_host, 'imap.example.test');
});

test('both to send only: IMAP is not dialled and is cleared on the same row', async () => {
  const res = await connect({ mode: 'smtp', ...SMTP });
  assert.equal(res.status, 200);
  assert.deepEqual(world.dialled, ['smtp:smtp.example.test']);
  assertSameRow();
  assert.equal(stored().imap_host, null);
  assert.equal(stored().imap_port, null);
  assert.equal(stored().smtp_host, 'smtp.example.test');
});

test('send only to receive only: swaps halves on the same row', async () => {
  reset('smtp');
  const res = await connect({ mode: 'imap', ...IMAP });
  assert.equal(res.status, 200);
  assert.equal(world.limitChecks, 0);
  assert.deepEqual(world.dialled, ['imap:imap.example.test']);
  assertSameRow();
  assert.equal(stored().imap_host, 'imap.example.test');
  assert.equal(stored().smtp_host, null);
});

test('a brand-new address at the cap is still refused (control)', async () => {
  world.rows.clear();
  const res = await connect({ mode: 'both', ...IMAP, ...SMTP });
  assert.equal(res.status, 402);
  assert.equal(world.limitChecks, 1);
  assert.equal(world.upserts.length, 0);
});
