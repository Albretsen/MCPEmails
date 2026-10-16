// ---------------------------------------------------------------------------
// GET /api/approvals (the queue) decrypts nothing; GET /api/approvals/[id] (the
// decision dialog) returns one approval's Bcc addresses, role-gated.
//
// Run with: npm run test:approvals
// Only the Supabase clients and the active-workspace lookup are stubbed.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/* eslint-disable @typescript-eslint/no-explicit-any */

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let signedIn: { id: string } | null = { id: 'user-1' };

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  let columns: string[] | null = null;
  // Projects to the selected columns, as PostgREST does, so a route that
  // stopped selecting the payload really does not get it.
  const project = (r: Row) =>
    columns ? Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r };
  const rows = () => (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v)).map(project);
  const builder: any = {
    select: (list = '*') => {
      const names = String(list).split(',').map((c) => c.trim()).filter((c) => c && !c.includes('('));
      columns = names.includes('*') ? null : names;
      return builder;
    },
    eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
    neq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: any) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
  };
  return builder;
}
const db = { from: query };

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn } }) } }) },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });

const { encryptToken } = await import('../../../src/lib/crypto.ts');
const detail = (await import('./[id]/route.ts')) as any;
const list = (await import('./route.ts')) as any;

const ID = '11111111-1111-4111-8111-111111111111';

function seed(role: string, payload: Row, operation = 'email_send') {
  tables = {
    send_approvals: [{
      id: ID,
      workspace_id: 'ws-1',
      inbox_id: 'inbox-1',
      operation,
      status: 'pending',
      revision: 3,
      summary: { to: ['colleague@example.com'], cc: [], bcc_count: 1, subject: 'Notes' },
      payload: { v: 1, data: encryptToken(JSON.stringify(payload)) },
      payload_encrypted: true,
      created_at: '2026-10-16T10:00:00.000Z',
    }],
    workspace_members: [{ workspace_id: 'ws-1', user_id: 'user-1', role }],
  };
}

const get = (id = ID) => detail.GET(new Request(`https://mcpemails.test/api/approvals/${id}`), { params: Promise.resolve({ id }) });

test('details: an owner gets the Bcc addresses, the revision and approvability', async () => {
  seed('owner', { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'x' });
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.bcc, ['drop@evil.example']);
  assert.equal(body.bcc_count, 1);
  assert.equal(body.revision, 3);
  assert.equal(body.approvable, true);
  assert.equal(body.subject, 'Notes');
  assert.equal('payload' in body, false, 'never the payload itself');
});

test('details: a viewer gets the count and no addresses', async () => {
  seed('viewer', { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'x' });
  const body = await (await get()).json();
  assert.deepEqual(body.bcc, []);
  assert.equal(body.bcc_count, 1);
});

test('details: a legacy draft send is reported as not approvable', async () => {
  seed('admin', { draft_id: 'g1', base_revision: 0 }, 'draft_send');
  assert.equal((await (await get()).json()).approvable, false);
});

test('details: no session is 401; another workspace and a bad id are the same 404', async () => {
  seed('owner', { bcc: [] });
  signedIn = null;
  assert.equal((await get()).status, 401);
  signedIn = { id: 'user-1' };
  tables.workspace_members = [];
  assert.equal((await get()).status, 404);
  assert.equal((await get('not-a-uuid')).status, 404);
});

test('queue: lists summaries with the revision, and no payload or Bcc addresses', async () => {
  seed('owner', { to: ['colleague@example.com'], bcc: ['drop@evil.example'], body: 'x' });
  const res = await list.GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].revision, 3);
  assert.equal(JSON.stringify(body).includes('drop@evil.example'), false);
  assert.equal(JSON.stringify(body).includes('"data"'), false, 'no ciphertext either');
});
