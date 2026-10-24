// ---------------------------------------------------------------------------
// /api/inboxes/[id]/instructions: validation, the Pro gate, roles, scoping.
//
//   - signed out is 401, an inbox the caller cannot see is 404;
//   - NOT VISIBLE (pre-launch) is 404 on every method, before the column is
//     read or written;
//   - visible on a lower plan: GET answers allowed:false, PUT is 403
//     pro_feature_required and writes nothing;
//   - a viewer may read, never write (403 insufficient_role);
//   - text is trimmed, empty or null clears, over 2000 characters is a 400;
//   - every read and write of the column goes through the service-role client
//     scoped to the inbox id AND its workspace; a missing column is 503;
//   - GET and PUT are the only exported methods.
//
// (Outside [id]/ because node --test reads its arguments as globs.)
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-0000000000a1' };
const WS = '11111111-1111-4111-8111-111111111111';
const INBOX = '22222222-2222-4222-8222-222222222222';

interface Call {
  client: 'user' | 'service';
  table: string;
  op: string;
  columns: string | null;
  filters: Array<[string, string, unknown]>;
  payload: unknown;
}

interface World {
  signedIn: boolean;
  visibleInbox: boolean;
  role: string | null;
  gate: { visible: boolean; allowed: boolean };
  stored: string | null;
  columnMissing: boolean;
  gateReads: number;
  calls: Call[];
}

let world: World;

function reset(overrides: Partial<World> = {}): void {
  world = {
    signedIn: true,
    visibleInbox: true,
    role: 'member',
    gate: { visible: true, allowed: true },
    stored: null,
    columnMissing: false,
    gateReads: 0,
    calls: [],
    ...overrides,
  };
}

function resolve(call: Call): { data: unknown; error: unknown } {
  if (call.table === 'workspace_members') return { data: world.role ? { role: world.role } : null, error: null };
  if (call.table !== 'inboxes') return { data: null, error: null };
  if (call.client === 'user') {
    if (call.columns !== 'id, workspace_id') return { data: null, error: { code: '42501', message: 'permission denied' } };
    return world.visibleInbox ? { data: { id: INBOX, workspace_id: WS }, error: null } : { data: null, error: { message: 'no rows' } };
  }
  if (world.columnMissing) return { data: null, error: { code: '42703', message: 'column does not exist' } };
  if (call.op === 'update') {
    world.stored = (call.payload as { ai_instructions: string | null }).ai_instructions;
    return { data: null, error: null };
  }
  return { data: { ai_instructions: world.stored, ai_instructions_updated_at: world.stored ? '2026-10-24T10:00:00.000Z' : null }, error: null };
}

function client(kind: 'user' | 'service') {
  return {
    from(table: string) {
      const call: Call = { client: kind, table, op: 'select', columns: null, filters: [], payload: null };
      const run = () => {
        world.calls.push(call);
        return resolve(call);
      };
      const builder: Record<string, unknown> = {};
      builder.select = (columns: string) => {
        call.columns = columns;
        return builder;
      };
      builder.update = (payload: unknown) => {
        call.op = 'update';
        call.payload = payload;
        return builder;
      };
      for (const f of ['eq', 'is']) {
        builder[f] = (col: string, val: unknown) => {
          call.filters.push([f, col, val]);
          return builder;
        };
      }
      builder.single = async () => run();
      builder.maybeSingle = async () => run();
      builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, ko);
      return builder;
    },
    auth: {
      getUser: async () => (world.signedIn ? { data: { user: USER }, error: null } : { data: { user: null }, error: null }),
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => client('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client('service') } });
nodeMock.module('@/lib/plans/pro-features', {
  namedExports: {
    loadProFeatureAccess: async (_user: unknown, _service: unknown, workspaceId: string) => {
      assert.equal(workspaceId, WS);
      world.gateReads += 1;
      return { ...world.gate, plan: world.gate.allowed ? 'solo' : 'free' };
    },
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const route = await import('./[id]/instructions/route.ts');
const params = { params: Promise.resolve({ id: INBOX }) };
const URL_BASE = `https://mcpemails.test/api/inboxes/${INBOX}/instructions`;

const get = () => route.GET(new Request(URL_BASE) as never, params);
const put = (body: unknown) =>
  route.PUT(new Request(URL_BASE, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never, params);

const columnCalls = () => world.calls.filter((c) => c.client === 'service' && c.table === 'inboxes');
const writes = () => columnCalls().filter((c) => c.op === 'update');

function assertScoped(): void {
  for (const c of world.calls.filter((c) => c.client === 'user' && c.table === 'inboxes')) {
    assert.equal(c.columns, 'id, workspace_id', 'the user client never reads the column');
    assert.equal(c.op, 'select');
  }
  for (const c of columnCalls()) {
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'id' && v === INBOX), `${c.op} scoped to the inbox`);
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'workspace_id' && v === WS), `${c.op} scoped to its workspace`);
  }
}

beforeEach(() => reset());

test('only GET and PUT are exported', () => {
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort(), ['GET', 'PUT']);
});

test('signed out: 401 on every method, nothing read', async () => {
  reset({ signedIn: false });
  assert.equal((await get()).status, 401);
  assert.equal((await put({ instructions: 'x' })).status, 401);
  assert.equal(columnCalls().length, 0);
  assert.equal(world.gateReads, 0);
});

test('an inbox the caller cannot see is 404 on every method', async () => {
  reset({ visibleInbox: false });
  assert.equal((await get()).status, 404);
  assert.equal((await put({ instructions: 'x' })).status, 404);
  assert.equal(columnCalls().length, 0);
});

test('not visible (pre-launch): 404 on every method, the column is never touched', async () => {
  reset({ gate: { visible: false, allowed: false }, stored: 'secret rules' });
  const g = await get();
  assert.equal(g.status, 404);
  assert.equal(JSON.stringify(await g.json()).includes('secret rules'), false);
  assert.equal((await put({ instructions: 'x' })).status, 404);
  assert.equal(columnCalls().length, 0);
  assert.equal(world.stored, 'secret rules');
});

test('visible on a lower plan: GET says allowed false, PUT is 403 and writes nothing', async () => {
  reset({ gate: { visible: true, allowed: false }, stored: 'kept from Pro' });
  const g = await get();
  assert.equal(g.status, 200);
  const body = await g.json();
  assert.equal(body.allowed, false);
  assert.equal(body.instructions, 'kept from Pro');
  assert.equal(body.max_chars, 2000);
  const p = await put({ instructions: 'new' });
  assert.equal(p.status, 403);
  assert.equal((await p.json()).error, 'pro_feature_required');
  assert.equal(writes().length, 0);
  assert.equal(world.stored, 'kept from Pro');
});

test('allowed: PUT trims and stores, GET returns it', async () => {
  const p = await put({ instructions: '  Sign as the Support Team.\n' });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).instructions, 'Sign as the Support Team.');
  assert.equal(world.stored, 'Sign as the Support Team.');
  const w = writes()[0].payload as { ai_instructions: string; ai_instructions_updated_at: string };
  assert.equal(typeof w.ai_instructions_updated_at, 'string');
  const body = await (await get()).json();
  assert.equal(body.instructions, 'Sign as the Support Team.');
  assert.equal(body.allowed, true);
  assertScoped();
});

test('empty text or null clears', async () => {
  reset({ stored: 'old' });
  assert.equal((await put({ instructions: '   ' })).status, 200);
  assert.equal(world.stored, null);
  reset({ stored: 'old' });
  assert.equal((await put({ instructions: null })).status, 200);
  assert.equal(world.stored, null);
});

test('length cap: 2000 accepted, 2001 refused before anything is read', async () => {
  assert.equal((await put({ instructions: 'a'.repeat(2000) })).status, 200);
  assert.equal(world.stored?.length, 2000);
  reset();
  const p = await put({ instructions: 'a'.repeat(2001) });
  assert.equal(p.status, 400);
  const body = await p.json();
  assert.equal(body.error, 'too_long');
  assert.equal(body.max_chars, 2000);
  assert.equal(world.calls.length, 0);
});

test('bad bodies are 400 before anything is read', async () => {
  for (const bad of ['not json', '[]', '{}', JSON.stringify({ instructions: 5 }), JSON.stringify({ instructions: ['x'] })]) {
    reset();
    const res = await put(bad);
    assert.equal(res.status, 400, bad);
    assert.equal(world.calls.length, 0, bad);
  }
});

test('a viewer may read but not write', async () => {
  reset({ role: 'viewer', stored: 'rules' });
  const g = await get();
  assert.equal(g.status, 200);
  assert.equal((await g.json()).can_manage, false);
  const p = await put({ instructions: 'x' });
  assert.equal(p.status, 403);
  assert.equal((await p.json()).error_code, 'insufficient_role');
  assert.equal(writes().length, 0);
});

test('missing column: 503 unavailable on both methods', async () => {
  reset({ columnMissing: true });
  assert.equal((await get()).status, 503);
  assert.equal((await put({ instructions: 'x' })).status, 503);
});
