// ---------------------------------------------------------------------------
// POST /api/inboxes/swap-parked: "Make active" on a parked inbox.
//
//   - signed out 401; a bad body 400; an inbox the caller cannot see 404;
//   - members and viewers 403 insufficient_role, owners and admins swap;
//   - a one-for-one swap: the parked inbox comes back, the picked one parks,
//     rules follow, the choice becomes the owner's keep order;
//   - without a pick only when there is a free slot under the cap
//     (pick_active otherwise); never above the cap (over_cap);
//   - one swap per workspace per rolling 24 hours (429 swap_limit), and a
//     failed swap gives the day back;
//   - the column not migrated yet is 503;
//   - POST is the only exported method (Next answers 405 for the others).
//
// (Outside swap-parked/ because node --test reads its arguments as globs.)
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000a2';
const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '11111111-1111-4111-8111-222222222222';
const A = '22222222-2222-4222-8222-00000000000a';
const B = '22222222-2222-4222-8222-00000000000b';
const C = '22222222-2222-4222-8222-00000000000c';
const STRANGER = '22222222-2222-4222-8222-0000000000ff';

const world: { db: FakeSupabase; signedIn: boolean; role: string | null; cap: number | null; visible: boolean } = {
  db: new FakeSupabase(),
  signedIn: true,
  role: 'owner',
  cap: 1,
  visible: true,
};

function userClient() {
  return {
    auth: {
      getUser: async () => (world.signedIn ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: null }),
    },
    from(table: string) {
      if (table === 'workspace_members') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: world.role ? { role: world.role } : null, error: null }),
        };
        return chain;
      }
      if (table === 'inboxes' && !world.visible) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      }
      return world.db.from(table);
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => userClient() } });
nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => world.db.from(table),
      rpc: (name: string, args: Record<string, unknown>) => world.db.rpc(name, args),
    }),
  },
});
nodeMock.module('@/lib/plans/check-inbox-limit', {
  namedExports: { checkInboxLimit: async () => ({ maxInboxes: world.cap }) },
});

const route = await import('./swap-parked/route.ts');
const { POST } = route;

function seed(options: { swappedAt?: string | null; keepOrder?: string[] | null } = {}) {
  world.db = new FakeSupabase();
  world.signedIn = true;
  world.role = 'owner';
  world.cap = 1;
  world.visible = true;
  const db = world.db;
  db.seed('workspaces', [
    { id: WS, owner_id: OWNER, deleted_at: null, inbox_swapped_at: options.swappedAt ?? null, pro_unlimited_inboxes_exempt: false },
    { id: OTHER_WS, owner_id: 'someone-else', deleted_at: null, inbox_swapped_at: null },
  ]);
  db.seed('inboxes', [
    { id: A, workspace_id: WS, created_at: '2026-01-01T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
    { id: B, workspace_id: WS, created_at: '2026-01-02T00:00:00Z', parked_at: '2026-10-20T00:00:00Z', parked_reason: 'plan_limit', deleted_at: null },
    { id: C, workspace_id: WS, created_at: '2026-01-03T00:00:00Z', parked_at: '2026-10-20T00:00:00Z', parked_reason: 'plan_limit', deleted_at: null },
    { id: STRANGER, workspace_id: OTHER_WS, created_at: '2026-01-01T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
  ]);
  db.seed('triage_rules', [
    { id: 'rule-a', workspace_id: WS, inbox_id: A, enabled: true, paused_reason: null, paused_until: null, deleted_at: null, next_run_at: null },
    { id: 'rule-b', workspace_id: WS, inbox_id: B, enabled: true, paused_reason: 'inbox_parked', paused_until: 'infinity', deleted_at: null, next_run_at: null },
  ]);
  db.seed('user_billing', [{ user_id: OWNER, plan: 'free', inbox_keep_order: options.keepOrder ?? null }]);
  db.onRpc('workspace_inbox_activity', () => ({ data: [], error: null }));
}

beforeEach(() => seed());

function post(body: unknown) {
  const request = new Request('https://mcpemails.test/api/inboxes/swap-parked', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(request as unknown as Parameters<typeof POST>[0]);
}

function parked(): string[] {
  return world.db.table('inboxes').filter((i) => i.workspace_id === WS && i.parked_at).map((i) => String(i.id)).sort();
}

function rule(id: string) {
  return world.db.table('triage_rules').find((r) => r.id === id)!;
}

function swappedAt() {
  return world.db.table('workspaces').find((w) => w.id === WS)!.inbox_swapped_at;
}

test('POST is the only exported method', () => {
  const methods = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort();
  assert.deepEqual(methods, ['POST']);
});

test('signed out is 401 and changes nothing', async () => {
  world.signedIn = false;
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 401);
  assert.deepEqual(parked(), [B, C].sort());
});

test('a bad body is 400', async () => {
  for (const body of ['not json', [], {}, { parkedInboxId: 'x' }, { parkedInboxId: B, activeInboxId: 5 }, { parkedInboxId: B, activeInboxId: B }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('an inbox the caller cannot see is 404', async () => {
  world.visible = false;
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 404);
});

test('members and viewers are refused; nothing changes', async () => {
  for (const role of ['member', 'viewer', null]) {
    world.role = role;
    const res = await post({ parkedInboxId: B, activeInboxId: A });
    assert.equal(res.status, 403, String(role));
    assert.equal((await res.json()).error_code, 'insufficient_role');
  }
  assert.deepEqual(parked(), [B, C].sort());
  assert.equal(swappedAt(), null);
});

test('an owner swaps one for one: rules follow and the choice is remembered', async () => {
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.active, [B]);
  assert.deepEqual(parked(), [A, C].sort());
  assert.ok(body.next_swap_at);
  assert.ok(swappedAt(), 'the clock is set');
  assert.equal(rule('rule-a').paused_reason, 'inbox_parked');
  assert.equal(rule('rule-b').paused_reason, null);
  const billing = world.db.table('user_billing').find((r) => r.user_id === OWNER)!;
  assert.deepEqual(billing.inbox_keep_order, [B]);
  const stranger = world.db.table('inboxes').find((i) => i.id === STRANGER)!;
  assert.equal(stranger.parked_at, null);
});

test('an admin may swap too', async () => {
  world.role = 'admin';
  const res = await post({ parkedInboxId: C, activeInboxId: A });
  assert.equal(res.status, 200);
  assert.deepEqual(parked(), [A, B].sort());
});

test('one swap a day: a second within 24 hours is 429 and changes nothing', async () => {
  assert.equal((await post({ parkedInboxId: B, activeInboxId: A })).status, 200);
  const res = await post({ parkedInboxId: C, activeInboxId: B });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'swap_limit');
  assert.ok(new Date(body.next_swap_at).getTime() > Date.now() + 23 * 3600_000);
  assert.deepEqual(parked(), [A, C].sort());
});

test('a swap 25 hours after the last is allowed', async () => {
  seed({ swappedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 200);
});

test('without a pick at the cap: pick_active, nothing changes', async () => {
  const res = await post({ parkedInboxId: B });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'pick_active');
  assert.deepEqual(parked(), [B, C].sort());
  assert.equal(swappedAt(), null, 'a refusal does not use the day');
});

test('without a pick under the cap: the parked inbox fills the free slot', async () => {
  world.cap = 2;
  const res = await post({ parkedInboxId: B });
  assert.equal(res.status, 200);
  assert.deepEqual(parked(), [C]);
});

test('never above the cap', async () => {
  world.cap = 0;
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'over_cap');
  assert.deepEqual(parked(), [B, C].sort());
});

test('an inbox that is not parked, or a pick that is not active, is 409', async () => {
  let res = await post({ parkedInboxId: A, activeInboxId: B });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'not_parked');
  res = await post({ parkedInboxId: B, activeInboxId: C });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'active_not_found');
  res = await post({ parkedInboxId: B, activeInboxId: STRANGER });
  assert.equal(res.status, 409, 'an inbox of another workspace is never touched');
  assert.equal(world.db.table('inboxes').find((i) => i.id === STRANGER)!.parked_at, null);
});

test('a failed swap is 500 and gives the day back', async () => {
  world.db.failTimes('triage_rules', { message: 'boom' }, 10);
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 500);
  assert.equal(swappedAt(), null);
});

test('before the migration the route answers 503', async () => {
  world.db.failOnce('workspaces', { code: '42703', message: 'column workspaces.inbox_swapped_at does not exist' });
  const res = await post({ parkedInboxId: B, activeInboxId: A });
  assert.equal(res.status, 503);
});
