// ---------------------------------------------------------------------------
// /api/api-keys: create, edit and revoke, end to end through the handlers.
//
// WHY. Two holes, fixed together (security unit u03):
//   1. POST inserted through the USER client, which meant a browser session
//      had an INSERT (and UPDATE) grant on api_keys. Any member, viewers
//      included, could skip this route and mint a send-capable key straight
//      through PostgREST, or rewrite another member's key_hash. The grant is
//      gone (migration 20261016160300), so the route now inserts through the
//      service role, after its checks.
//   2. Revoke and edit checked only membership. A viewer could revoke the
//      owner's keys; a member could widen anybody's key; the viewer scope cap
//      looked at the editor, not at who holds the key.
//
// Stubbed: the two Supabase clients (one in-memory database behind both; the
// user client REFUSES writes to api_keys exactly as the revoked grant does),
// next/headers, next/server, the rate limiter, the funnel recorder and the
// plan-cap check (every real plan is unlimited, so the cap is driven here).
// Everything else (validation, role rules, scope caps, the writes) is real.
//
// Run: npm run test:api-keys
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';
import crypto from 'node:crypto';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;

const WS = 'w0000000-0000-0000-0000-000000000001';
const OTHER_WS = 'w0000000-0000-0000-0000-000000000002';
const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const MEMBER2 = 'u-member2';
const VIEWER = 'u-viewer';
const GONE = 'u-gone';
const OUTSIDER = 'u-outsider';

const world = {
  user: null as { id: string } | null,
  rateLimited: false,
  keyLimit: { atLimit: false, plan: 'free', currentCount: 0, maxApiKeys: null as number | null },
  keyLimitCalls: [] as string[],
  db: {} as Record<string, Row[]>,
  /** Every write either client attempted: `${client}:${op}:${table}`. */
  writes: [] as string[],
};

function seed() {
  world.db = {
    workspace_members: [
      { workspace_id: WS, user_id: OWNER, role: 'owner', joined_at: '2026-01-01' },
      { workspace_id: WS, user_id: ADMIN, role: 'admin', joined_at: '2026-01-02' },
      { workspace_id: WS, user_id: MEMBER, role: 'member', joined_at: '2026-01-03' },
      { workspace_id: WS, user_id: MEMBER2, role: 'member', joined_at: '2026-01-04' },
      { workspace_id: WS, user_id: VIEWER, role: 'viewer', joined_at: '2026-01-05' },
      { workspace_id: OTHER_WS, user_id: OUTSIDER, role: 'owner', joined_at: '2026-01-01' },
    ],
    api_keys: [
      key('k-owner', OWNER, ['read:email', 'send:email']),
      key('k-admin', ADMIN, ['read:email']),
      key('k-member', MEMBER, ['read:email']),
      key('k-member2', MEMBER2, ['read:email', 'send:email']),
      key('k-viewer', VIEWER, ['read:email']),
      key('k-gone', GONE, ['read:email', 'send:email']),
      key('k-legacy', null, ['read:email']),
      key('k-revoked-member', MEMBER, ['read:email'], { deleted_at: '2026-10-01T00:00:00.000Z' }),
      key('k-webclient', null, ['read:email', 'send:email'], { kind: 'web_client' }),
      key('k-outsider', OUTSIDER, ['read:email'], { workspace_id: OTHER_WS }),
    ],
    inboxes: [
      { id: 'ib-1', workspace_id: WS, deleted_at: null },
      { id: 'ib-2', workspace_id: WS, deleted_at: null },
      { id: 'ib-foreign', workspace_id: OTHER_WS, deleted_at: null },
    ],
    oauth_refresh_tokens: [
      { id: 'rt-owner', api_key_id: 'k-owner', workspace_id: WS, revoked_at: null, scopes: ['read:email'], inbox_ids: null },
      { id: 'rt-member', api_key_id: 'k-member', workspace_id: WS, revoked_at: null, scopes: ['read:email'], inbox_ids: null },
      { id: 'rt-revoked-member', api_key_id: 'k-revoked-member', workspace_id: WS, revoked_at: null, scopes: ['read:email'], inbox_ids: null },
    ],
  };
}

function key(id: string, createdBy: string | null, scopes: string[], extra: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    created_by: createdBy,
    name: `Key ${id}`,
    key_prefix: id.slice(0, 8),
    key_hash: `hash-${id}`,
    scopes,
    inbox_ids: null,
    kind: null,
    deleted_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    ...extra,
  };
}

let nextId = 1;

/** A PostgREST-shaped builder over world.db. */
function fakeClient(kind: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: world.user }, error: null }) },
    rpc: async () => ({ data: [{ plan: 'free', comped_scale: false, unlimited_inboxes: false }], error: null }),
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row | null = null;
      let returning = false;
      let head = false;
      let range: [number, number] | null = null;
      let limit: number | null = null;
      const b: Record<string, unknown> = {};
      b.select = (_cols?: string, opts?: { head?: boolean }) => {
        if (op === 'select') head = opts?.head === true;
        else returning = true;
        return b;
      };
      b.insert = (row: Row) => ((op = 'insert'), (payload = row), b);
      b.update = (row: Row) => ((op = 'update'), (payload = row), b);
      b.delete = () => ((op = 'delete'), b);
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
      b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
      b.order = () => b;
      b.range = (from: number, to: number) => ((range = [from, to]), b);
      b.limit = (n: number) => ((limit = n), b);

      const table_ = () => (world.db[table] ??= []);
      const matching = () => table_().filter((r) => filters.every((f) => f(r)));

      const run = (): { data: unknown; error: unknown; count?: number } => {
        if (op !== 'select') {
          world.writes.push(`${kind}:${op}:${table}`);
          // The revoked grant: a browser session may not write api_keys at all.
          if (kind === 'user' && table === 'api_keys') {
            return { data: null, error: { code: '42501', message: 'permission denied for table api_keys' } };
          }
        }
        if (op === 'insert') {
          const row = {
            id: `new-${nextId++}`,
            kind: null,
            deleted_at: null,
            inbox_ids: null,
            created_at: '2026-10-16T12:00:00.000Z',
            last_used_at: null,
            expires_at: null,
            ...payload,
          };
          table_().push(row);
          return { data: returning ? [row] : null, error: null };
        }
        if (op === 'update') {
          const rows = matching();
          for (const r of rows) Object.assign(r, payload);
          return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null };
        }
        if (op === 'delete') {
          const rows = matching();
          world.db[table] = table_().filter((r) => !rows.includes(r));
          return { data: null, error: null };
        }
        let rows = matching().map((r) => ({ ...r }));
        if (head) return { data: null, error: null, count: rows.length };
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit != null) rows = rows.slice(0, limit);
        return { data: rows, error: null, count: rows.length };
      };

      b.single = async () => {
        const { data, error } = run();
        const rows = (data as Row[] | null) ?? [];
        if (error) return { data: null, error };
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not one row' } };
      };
      b.maybeSingle = async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        return { data: ((data as Row[] | null) ?? [])[0] ?? null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject);
      return b;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fakeClient('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fakeClient('service') } });
nodeMock.module('next/headers', {
  namedExports: { cookies: async () => ({ get: (name: string) => (name === 'mcpe_active_ws' ? { value: WS } : undefined) }) },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});
nodeMock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => world.rateLimited } });
nodeMock.module('@/lib/analytics/product-funnel', { namedExports: { recordProductFunnelEvent: async () => undefined } });
nodeMock.module('@/lib/plans/check-api-key-limit', {
  namedExports: {
    checkApiKeyLimit: async (_client: unknown, workspaceId: string) => {
      world.keyLimitCalls.push(workspaceId);
      return world.keyLimit;
    },
  },
});

const createRoute = (await import('./route.ts')) as unknown as { POST: (r: Request) => Promise<Response> };
const editRoute = (await import('./[id]/route.ts')) as unknown as {
  PATCH: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};
const revokeRoute = (await import('./[id]/revoke/route.ts')) as unknown as {
  PATCH: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};

beforeEach(() => {
  seed();
  world.user = null;
  world.rateLimited = false;
  world.keyLimit = { atLimit: false, plan: 'free', currentCount: 0, maxApiKeys: null };
  world.keyLimitCalls = [];
  world.writes = [];
});

const as = (id: string) => { world.user = { id }; };
const keyRow = (id: string) => world.db.api_keys.find((k) => k.id === id)!;
const rt = (id: string) => world.db.oauth_refresh_tokens.find((r) => r.id === id)!;

function create(body: unknown) {
  return createRoute.POST(new Request('https://mcpemails.test/api/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
function edit(id: string, body: unknown) {
  return editRoute.PATCH(new Request(`https://mcpemails.test/api/api-keys/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}
function revoke(id: string) {
  return revokeRoute.PATCH(new Request(`https://mcpemails.test/api/api-keys/${id}/revoke`, { method: 'PATCH' }), {
    params: Promise.resolve({ id }),
  });
}

/** No route may write api_keys through the user client: the grant is gone. */
function assertNoUserClientKeyWrites() {
  assert.deepEqual(world.writes.filter((w) => w.startsWith('user:') && w.endsWith(':api_keys')), []);
}

// ===========================================================================
// POST /api/api-keys
// ===========================================================================

test('create: a member gets a key, inserted through the service role, response shape unchanged', async () => {
  as(MEMBER);
  const res = await create({ name: '  Claude Desktop ', scopes: ['read:email', 'send:email', 'read:email'], workspaceId: WS });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'expiresAt', 'id', 'keyPrefix', 'lastUsedAt', 'name', 'rawKey', 'scopes']);
  assert.equal(body.name, 'Claude Desktop');
  assert.deepEqual(body.scopes, ['read:email', 'send:email'], 'scopes are deduplicated');
  assert.match(body.rawKey, /^mcpe_[0-9a-f]{64}$/);
  assert.equal(body.keyPrefix, body.rawKey.slice(5, 13));
  assert.equal('key_hash' in body || 'keyHash' in body, false, 'the hash is never returned');

  const stored = keyRow(body.id);
  assert.equal(stored.workspace_id, WS);
  assert.equal(stored.created_by, MEMBER);
  assert.equal(stored.key_hash, crypto.createHash('sha256').update(body.rawKey).digest('hex'));
  assert.deepEqual(world.writes, ['service:insert:api_keys']);
  assertNoUserClientKeyWrites();
});

test('create: fields smuggled into the body (created_by, key_hash, kind, workspace) are ignored', async () => {
  as(MEMBER);
  const res = await create({
    name: 'Smuggler', scopes: ['read:email'], workspaceId: WS,
    created_by: OWNER, key_hash: 'chosen', kind: 'web_client', workspace_id: OTHER_WS, inbox_ids: ['ib-foreign'],
  });
  assert.equal(res.status, 201);
  const stored = keyRow((await res.json()).id);
  assert.equal(stored.created_by, MEMBER);
  assert.notEqual(stored.key_hash, 'chosen');
  assert.equal(stored.kind, null);
  assert.equal(stored.workspace_id, WS);
  assert.equal(stored.inbox_ids, null);
});

test('create: the active workspace is used when the body names none', async () => {
  as(VIEWER);
  const res = await create({ name: 'Reader', scopes: ['read:email', 'search:email'] });
  assert.equal(res.status, 201);
  const stored = keyRow((await res.json()).id);
  assert.equal(stored.workspace_id, WS);
  assert.equal(stored.created_by, VIEWER);
});

test('create: a viewer still cannot mint a key beyond the read-only allow-list', async () => {
  as(VIEWER);
  const res = await create({ name: 'Sender', scopes: ['read:email', 'send:email'], workspaceId: WS });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error_code, 'insufficient_role');
  assert.match(body.error, /send:email/);
  assert.deepEqual(world.writes, [], 'nothing was written');
});

test('create: the plan key cap is still enforced before any write', async () => {
  as(OWNER);
  world.keyLimit = { atLimit: true, plan: 'free', currentCount: 3, maxApiKeys: 3 };
  const res = await create({ name: 'One too many', scopes: ['read:email'], workspaceId: WS });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error_code, 'api_key_limit_reached');
  assert.equal(body.max_api_keys, 3);
  assert.equal(body.current_count, 3);
  assert.deepEqual(world.keyLimitCalls, [WS]);
  assert.deepEqual(world.writes, []);
});

test('create: the rate limit, duplicate names and validation still answer as before', async () => {
  as(MEMBER);
  world.rateLimited = true;
  assert.equal((await create({ name: 'x', scopes: ['read:email'], workspaceId: WS })).status, 429);
  world.rateLimited = false;

  const dup = await create({ name: 'key K-OWNER', scopes: ['read:email'], workspaceId: WS });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error_code, 'duplicate_name');

  assert.equal((await create({ name: '', scopes: ['read:email'] })).status, 400);
  assert.equal((await create({ name: 'x', scopes: [] })).status, 400);
  assert.equal((await create({ name: 'x', scopes: ['root:everything'] })).status, 400);
  assert.deepEqual(world.writes, []);
});

test('create: a workspace the caller is not a member of is refused', async () => {
  as(MEMBER);
  const res = await create({ name: 'Elsewhere', scopes: ['read:email'], workspaceId: OTHER_WS });
  assert.equal(res.status, 403);
  assert.deepEqual(world.writes, []);
});

test('create: unauthenticated is 401', async () => {
  assert.equal((await create({ name: 'x', scopes: ['read:email'] })).status, 401);
});

// ===========================================================================
// PATCH /api/api-keys/[id]/revoke
// ===========================================================================

test('revoke: a viewer cannot revoke the owner\'s key or its OAuth chain', async () => {
  as(VIEWER);
  const res = await revoke('k-owner');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error_code, 'insufficient_role');
  assert.equal(keyRow('k-owner').deleted_at, null);
  assert.equal(rt('rt-owner').revoked_at, null);
  assert.deepEqual(world.writes, []);
});

test('revoke: a member cannot revoke another member\'s key', async () => {
  as(MEMBER2);
  assert.equal((await revoke('k-member')).status, 403);
  assert.equal(keyRow('k-member').deleted_at, null);
  assert.equal(rt('rt-member').revoked_at, null);
});

test('revoke: a member cannot revoke a key with no creator (owner/admin only)', async () => {
  as(MEMBER);
  assert.equal((await revoke('k-legacy')).status, 403);
  assert.equal(keyRow('k-legacy').deleted_at, null);
});

test('revoke: a member revokes their own key, and its refresh chain dies with it', async () => {
  as(MEMBER);
  const res = await revoke('k-member');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked: true });
  assert.ok(keyRow('k-member').deleted_at);
  assert.ok(rt('rt-member').revoked_at);
  assertNoUserClientKeyWrites();
});

test('revoke: a viewer may still revoke their own key', async () => {
  as(VIEWER);
  assert.equal((await revoke('k-viewer')).status, 200);
  assert.ok(keyRow('k-viewer').deleted_at);
});

test('revoke: owner and admin may revoke anybody\'s key, including a legacy one', async () => {
  as(ADMIN);
  assert.equal((await revoke('k-member')).status, 200);
  assert.ok(keyRow('k-member').deleted_at);
  as(OWNER);
  assert.equal((await revoke('k-viewer')).status, 200);
  assert.ok(keyRow('k-viewer').deleted_at);
  assert.equal((await revoke('k-legacy')).status, 200);
  assert.ok(keyRow('k-legacy').deleted_at);
});

test('revoke: re-revoking your own already-revoked key still finishes off its refresh chain', async () => {
  as(MEMBER);
  const before = keyRow('k-revoked-member').deleted_at;
  assert.equal((await revoke('k-revoked-member')).status, 200);
  assert.equal(keyRow('k-revoked-member').deleted_at, before, 'deleted_at keeps naming when access ended');
  assert.ok(rt('rt-revoked-member').revoked_at);
});

test('revoke: an unknown id, another workspace\'s key and the hidden web_client key are untouched no-ops', async () => {
  as(OWNER);
  for (const id of ['k-does-not-exist', 'k-outsider', 'k-webclient']) {
    const res = await revoke(id);
    assert.equal(res.status, 200, id);
  }
  assert.equal(keyRow('k-outsider').deleted_at, null);
  assert.equal(keyRow('k-webclient').deleted_at, null);
  assert.deepEqual(world.writes, []);
});

test('revoke: unauthenticated is 401', async () => {
  assert.equal((await revoke('k-owner')).status, 401);
});

// ===========================================================================
// PATCH /api/api-keys/[id]
// ===========================================================================

test('edit: a member cannot widen or re-scope another member\'s key', async () => {
  as(MEMBER);
  const res = await edit('k-member2', { scopes: ['read:email', 'send:email', 'delete:email'], inboxIds: null });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error_code, 'insufficient_role');
  assert.deepEqual(keyRow('k-member2').scopes, ['read:email', 'send:email']);
  assert.deepEqual(world.writes, []);
});

test('edit: a member cannot lift the inbox restriction on the owner\'s key', async () => {
  keyRow('k-owner').inbox_ids = ['ib-1'];
  as(MEMBER);
  assert.equal((await edit('k-owner', { scopes: ['read:email'], inboxIds: null })).status, 403);
  assert.deepEqual(keyRow('k-owner').inbox_ids, ['ib-1']);
});

test('edit: a viewer cannot edit somebody else\'s key even within read-only scopes', async () => {
  as(VIEWER);
  assert.equal((await edit('k-member', { scopes: ['read:email'], inboxIds: ['ib-1'] })).status, 403);
  assert.equal(keyRow('k-member').inbox_ids, null);
});

test('edit: a member edits their own key freely, and the refresh chain is synced', async () => {
  as(MEMBER);
  const res = await edit('k-member', { scopes: ['read:email', 'send:email'], inboxIds: ['ib-1', 'ib-2'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.scopes, ['read:email', 'send:email']);
  assert.deepEqual(body.inboxIds, ['ib-1', 'ib-2']);
  assert.deepEqual(keyRow('k-member').scopes, ['read:email', 'send:email']);
  assert.deepEqual(rt('rt-member').scopes, ['read:email', 'send:email']);
  assert.deepEqual(rt('rt-member').inbox_ids, ['ib-1', 'ib-2']);
  assertNoUserClientKeyWrites();
});

test('edit: a viewer edits their own key, inside the allow-list only', async () => {
  as(VIEWER);
  const refused = await edit('k-viewer', { scopes: ['read:email', 'send:email'], inboxIds: null });
  assert.equal(refused.status, 403);
  assert.deepEqual(keyRow('k-viewer').scopes, ['read:email']);

  const ok = await edit('k-viewer', { scopes: ['read:email', 'search:email'], inboxIds: ['ib-1'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(keyRow('k-viewer').scopes, ['read:email', 'search:email']);
});

test('edit: an admin cannot hand a VIEWER\'s key send:email (cap follows the key creator)', async () => {
  as(ADMIN);
  const res = await edit('k-viewer', { scopes: ['read:email', 'send:email'], inboxIds: null });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error_code, 'insufficient_role');
  assert.match(body.error, /viewer/);
  assert.deepEqual(keyRow('k-viewer').scopes, ['read:email']);

  as(OWNER);
  assert.equal((await edit('k-viewer', { scopes: ['manage:automations'], inboxIds: null })).status, 403);
});

test('edit: an admin can still narrow a viewer\'s key or change its inboxes', async () => {
  as(ADMIN);
  const res = await edit('k-viewer', { scopes: ['search:email'], inboxIds: ['ib-2'] });
  assert.equal(res.status, 200);
  assert.deepEqual(keyRow('k-viewer').scopes, ['search:email']);
  assert.deepEqual(keyRow('k-viewer').inbox_ids, ['ib-2']);
});

test('edit: the owner may widen a member\'s key, and change the owner\'s own key', async () => {
  as(OWNER);
  assert.equal((await edit('k-member', { scopes: ['read:email', 'send:email', 'delete:email'], inboxIds: null })).status, 200);
  assert.deepEqual(keyRow('k-member').scopes, ['read:email', 'send:email', 'delete:email']);
  assert.equal((await edit('k-owner', { scopes: ['read:email'], inboxIds: ['ib-1'] })).status, 200);
  assert.deepEqual(rt('rt-owner').inbox_ids, ['ib-1']);
});

test('edit: a key whose creator left may keep or drop its scopes but not gain new ones', async () => {
  as(OWNER);
  const widen = await edit('k-gone', { scopes: ['read:email', 'send:email', 'delete:email'], inboxIds: null });
  assert.equal(widen.status, 403);
  assert.deepEqual(keyRow('k-gone').scopes, ['read:email', 'send:email']);

  const keep = await edit('k-gone', { scopes: ['read:email', 'send:email'], inboxIds: ['ib-1'] });
  assert.equal(keep.status, 200);
  assert.deepEqual(keyRow('k-gone').inbox_ids, ['ib-1']);

  const narrow = await edit('k-gone', { scopes: ['read:email'], inboxIds: null });
  assert.equal(narrow.status, 200);
  assert.deepEqual(keyRow('k-gone').scopes, ['read:email']);
});

test('edit: unknown, revoked, hidden and other-workspace keys are 404 and untouched', async () => {
  as(OWNER);
  for (const id of ['k-does-not-exist', 'k-revoked-member', 'k-webclient', 'k-outsider']) {
    assert.equal((await edit(id, { scopes: ['read:email'], inboxIds: null })).status, 404, id);
  }
  assert.deepEqual(world.writes, []);
});

test('edit: an inbox outside the workspace is still refused', async () => {
  as(MEMBER);
  assert.equal((await edit('k-member', { scopes: ['read:email'], inboxIds: ['ib-1', 'ib-foreign'] })).status, 400);
  assert.equal(keyRow('k-member').inbox_ids, null);
});

test('edit: body validation still answers 400 before any lookup', async () => {
  as(OWNER);
  assert.equal((await edit('k-member', { scopes: [], inboxIds: null })).status, 400);
  assert.equal((await edit('k-member', { scopes: ['read:email'], inboxIds: [] })).status, 400);
  assert.equal((await edit('k-member', { scopes: ['nope'] })).status, 400);
  assert.deepEqual(world.writes, []);
});
