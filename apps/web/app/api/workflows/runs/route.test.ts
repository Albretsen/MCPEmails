// ---------------------------------------------------------------------------
// PATCH /api/workflows/runs: who may stop a bulk run.
//
// The route used to prove only workspace membership and then flip any running
// bulk_runs row to `cancelling` through the service-role client, so a viewer
// (read-only by policy, lib/workspace/roles.ts) could stop an owner's bulk
// cleanup halfway. It now reads the caller's role with the USER client and
// requires canOperateWorkspace before the service-role write.
//
// Only I/O is stubbed: the two Supabase clients, the active-workspace cookie
// lookup and next/server. roles.ts is the real module, so a regression in the
// policy itself also fails here.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/workflows/runs/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-0000000b0001' };
const WORKSPACE_ID = 'ws-0001';
const RUN_ID = 'run-0001';

interface World {
  authed: boolean;
  /** The role the USER client's workspace_members read returns; null = no row. */
  role: string | null;
  roleError: { message: string } | null;
  /** The running row the service-role update would match; null = none. */
  running: boolean;
  /** Every query, tagged by which client ran it. */
  log: string[];
  /** Filters the user client applied to its workspace_members read. */
  roleFilters: Record<string, unknown>;
  updates: Array<{ values: Record<string, unknown>; filters: Record<string, unknown> }>;
}

let world: World;

function reset(overrides: Partial<World> = {}): void {
  world = {
    authed: true,
    role: 'member',
    roleError: null,
    running: true,
    log: [],
    roleFilters: {},
    updates: [],
    ...overrides,
  };
}

/** The request-scoped user client: auth + the workspace_members role read. */
function userClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: world.authed ? USER : null }, error: null }),
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: unknown) => {
        world.roleFilters[column] = value;
        return builder;
      };
      builder.maybeSingle = async () => {
        world.log.push(`user:${table}.select`);
        if (world.roleError) return { data: null, error: world.roleError };
        return { data: world.role === null ? null : { role: world.role }, error: null };
      };
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => userClient() },
});

nodeMock.module('@/lib/workspace/active', {
  namedExports: { resolveActiveWorkspaceId: async () => WORKSPACE_ID },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => ({
        update: (values: Record<string, unknown>) => {
          const filters: Record<string, unknown> = {};
          const builder: Record<string, unknown> = {};
          builder.eq = (column: string, value: unknown) => {
            filters[column] = value;
            return builder;
          };
          builder.select = () => builder;
          builder.maybeSingle = async () => {
            world.log.push(`service:${table}.update`);
            world.updates.push({ values, filters });
            return world.running
              ? { data: { id: filters.id, status: 'cancelling' }, error: null }
              : { data: null, error: null };
          };
          return builder;
        },
      }),
    }),
  },
});

nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    },
  },
});

const route = (await import('./route.ts')) as Record<string, unknown>;
const PATCH = route.PATCH as (req: Request) => Promise<Response>;

function patch(body: unknown = { id: RUN_ID }): Request {
  return new Request('https://mcpemails.test/api/workflows/runs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const serviceWrites = () => world.log.filter((entry) => entry.startsWith('service:'));

beforeEach(() => reset());

// ── Refused ──────────────────────────────────────────────────────────────────

test('a viewer is refused with 403 insufficient_role and nothing is written', async () => {
  reset({ role: 'viewer' });
  const res = await PATCH(patch());
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error_code, 'insufficient_role');
  assert.match(body.error, /viewers/i, 'the message says why');
  assert.match(body.error, /cannot stop/i);
  assert.deepEqual(serviceWrites(), [], 'no service-role update may run for a viewer');
});

test('the role is read with the USER client, for this caller in the active workspace', async () => {
  reset({ role: 'viewer' });
  await PATCH(patch());
  assert.deepEqual(world.log, ['user:workspace_members.select']);
  assert.deepEqual(world.roleFilters, { workspace_id: WORKSPACE_ID, user_id: USER.id });
});

test('no membership row (role null) is refused, not assumed harmless', async () => {
  reset({ role: null });
  const res = await PATCH(patch());
  assert.equal(res.status, 403);
  assert.deepEqual(serviceWrites(), []);
});

test('an unrecognised role value is refused', async () => {
  reset({ role: 'superuser' });
  const res = await PATCH(patch());
  assert.equal(res.status, 403);
  assert.deepEqual(serviceWrites(), []);
});

test('a failed role read fails closed', async () => {
  reset({ roleError: { message: 'boom' } });
  const res = await PATCH(patch());
  assert.equal(res.status, 403);
  assert.deepEqual(serviceWrites(), []);
});

test('unauthenticated is 401 before any read', async () => {
  reset({ authed: false });
  const res = await PATCH(patch());
  assert.equal(res.status, 401);
  assert.deepEqual(world.log, []);
});

test('a missing run id is still 400', async () => {
  const res = await PATCH(patch({}));
  assert.equal(res.status, 400);
  assert.deepEqual(serviceWrites(), []);
});

// ── Allowed ──────────────────────────────────────────────────────────────────

for (const role of ['owner', 'admin', 'member']) {
  test(`${role} can stop a running run, scoped to the run, workspace and running status`, async () => {
    reset({ role });
    const res = await PATCH(patch());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { run: { id: RUN_ID, status: 'cancelling' } });
    assert.deepEqual(world.log, ['user:workspace_members.select', 'service:bulk_runs.update']);
    assert.equal(world.updates.length, 1);
    const [{ values, filters }] = world.updates;
    assert.equal(values.status, 'cancelling');
    assert.equal(typeof values.cancel_requested_at, 'string');
    assert.deepEqual(filters, { id: RUN_ID, workspace_id: WORKSPACE_ID, status: 'running' });
  });
}

test('a member stopping a run that already finished still gets 409', async () => {
  reset({ role: 'member', running: false });
  const res = await PATCH(patch());
  assert.equal(res.status, 409);
});
