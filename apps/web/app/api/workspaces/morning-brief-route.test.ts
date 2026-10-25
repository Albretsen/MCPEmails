// ---------------------------------------------------------------------------
// /api/workspaces/[id]/morning-brief: validation, the Pro gate, roles, scoping.
//
//   - signed out is 401, a workspace the caller cannot see is 404;
//   - NOT VISIBLE (pre-launch) is 404 on every method, the table untouched;
//   - visible on a lower plan: GET answers allowed:false, PUT is 403
//     pro_feature_required and writes nothing;
//   - members and viewers may read, only owners and admins write;
//   - bad bodies are 400 before anything is read; the target inbox must be a
//     live inbox of THIS workspace;
//   - a save resets the schedule, failures and pause;
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
const OTHER_INBOX = '33333333-3333-4333-8333-333333333333';

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
  member: boolean;
  role: string | null;
  gate: { visible: boolean; allowed: boolean };
  stored: Record<string, unknown> | null;
  tableMissing: boolean;
  gateReads: number;
  calls: Call[];
}

let world: World;

function reset(overrides: Partial<World> = {}): void {
  world = {
    signedIn: true,
    member: true,
    role: 'owner',
    gate: { visible: true, allowed: true },
    stored: null,
    tableMissing: false,
    gateReads: 0,
    calls: [],
    ...overrides,
  };
}

function resolve(call: Call): { data: unknown; error: unknown } {
  if (call.table === 'workspace_members') return { data: world.role ? { role: world.role } : null, error: null };
  if (call.table === 'workspaces') {
    assert.equal(call.client, 'user', 'membership is proven through the RLS client');
    return world.member ? { data: { id: WS }, error: null } : { data: null, error: null };
  }
  if (call.table === 'inboxes') {
    const id = call.filters.find(([, c]) => c === 'id')?.[2];
    const ws = call.filters.find(([, c]) => c === 'workspace_id')?.[2];
    return id === INBOX && ws === WS ? { data: { id: INBOX }, error: null } : { data: null, error: null };
  }
  if (call.table === 'morning_briefs') {
    assert.equal(call.client, 'service');
    if (world.tableMissing) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    if (call.op === 'upsert') {
      world.stored = { ...(call.payload as Record<string, unknown>) };
      return { data: null, error: null };
    }
    return { data: world.stored ? { last_sent_at: null, last_run_at: null, last_outcome: null, last_error_code: null, ...world.stored } : null, error: null };
  }
  return { data: null, error: null };
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
      builder.upsert = (payload: unknown) => {
        call.op = 'upsert';
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

const route = await import('./[id]/morning-brief/route.ts');
const params = { params: Promise.resolve({ id: WS }) };
const URL_BASE = `https://mcpemails.test/api/workspaces/${WS}/morning-brief`;
const GOOD = { enabled: true, hour: 7, timezone: 'Europe/Oslo', locale: 'en', inbox_id: INBOX, vip_senders: ['boss@example.com'] };

const get = () => route.GET(new Request(URL_BASE) as never, params);
const put = (body: unknown) =>
  route.PUT(new Request(URL_BASE, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never, params);
const briefCalls = () => world.calls.filter((c) => c.table === 'morning_briefs');
const writes = () => briefCalls().filter((c) => c.op === 'upsert');

beforeEach(() => reset());

test('only GET and PUT are exported', () => {
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort(), ['GET', 'PUT']);
});

test('signed out: 401 on every method, nothing read', async () => {
  reset({ signedIn: false });
  assert.equal((await get()).status, 401);
  assert.equal((await put(GOOD)).status, 401);
  assert.equal(briefCalls().length, 0);
  assert.equal(world.gateReads, 0);
});

test('a workspace the caller is not in is 404', async () => {
  reset({ member: false });
  assert.equal((await get()).status, 404);
  assert.equal((await put(GOOD)).status, 404);
  assert.equal(briefCalls().length, 0);
});

test('not visible (pre-launch): 404 on every method, the table is never touched', async () => {
  reset({ gate: { visible: false, allowed: false }, stored: { ...GOOD } });
  assert.equal((await get()).status, 404);
  assert.equal((await put(GOOD)).status, 404);
  assert.equal(briefCalls().length, 0);
});

test('visible on a lower plan: GET says allowed false, PUT is 403 and writes nothing', async () => {
  reset({ gate: { visible: true, allowed: false } });
  const g = await get();
  assert.equal(g.status, 200);
  const body = await g.json();
  assert.equal(body.allowed, false);
  assert.equal(body.settings, null);
  assert.equal(body.defaults.enabled, false);
  const p = await put(GOOD);
  assert.equal(p.status, 403);
  assert.equal((await p.json()).error, 'pro_feature_required');
  assert.equal(writes().length, 0);
});

test('allowed: PUT stores the settings, resets the schedule, GET returns them', async () => {
  reset({ stored: { ...GOOD, paused_at: '2026-10-20T00:00:00Z', consecutive_failures: 5 } });
  const p = await put({ ...GOOD, vip_senders: ['@VIP.example', 'vip.example'] });
  assert.equal(p.status, 200);
  const w = writes()[0];
  assert.ok(w.filters.length === 0, 'upsert has no filters; its key is the payload workspace_id');
  const payload = w.payload as Record<string, unknown>;
  assert.equal(payload.workspace_id, WS);
  assert.deepEqual(payload.vip_senders, ['vip.example']);
  assert.equal(payload.next_due_at, null);
  assert.equal(payload.paused_at, null);
  assert.equal(payload.consecutive_failures, 0);
  const body = await (await get()).json();
  assert.equal(body.settings.timezone, 'Europe/Oslo');
  assert.equal(body.status.paused, false);
  assert.equal(body.allowed, true);
  assert.equal(body.can_manage, true);
});

test('the target inbox must belong to this workspace', async () => {
  const p = await put({ ...GOOD, inbox_id: OTHER_INBOX });
  assert.equal(p.status, 400);
  assert.equal((await p.json()).error, 'invalid_inbox');
  assert.equal(writes().length, 0);
});

test('bad bodies are 400 before anything is read', async () => {
  for (const bad of ['not json', '[]', '{}', JSON.stringify({ ...GOOD, hour: 25 }), JSON.stringify({ ...GOOD, timezone: 'Nowhere/Land' })]) {
    reset();
    const res = await put(bad);
    assert.equal(res.status, 400, bad);
    assert.equal(world.calls.length, 0, bad);
  }
});

test('members and viewers may read but not write', async () => {
  for (const role of ['member', 'viewer']) {
    reset({ role });
    const g = await get();
    assert.equal(g.status, 200);
    assert.equal((await g.json()).can_manage, false);
    const p = await put(GOOD);
    assert.equal(p.status, 403);
    assert.equal((await p.json()).error_code, 'insufficient_role');
    assert.equal(writes().length, 0);
  }
});

test('missing table: 503 unavailable on both methods', async () => {
  reset({ tableMissing: true });
  assert.equal((await get()).status, 503);
  assert.equal((await put(GOOD)).status, 503);
});
