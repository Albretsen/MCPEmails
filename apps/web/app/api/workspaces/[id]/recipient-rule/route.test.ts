// ---------------------------------------------------------------------------
// /api/workspaces/[id]/recipient-rule: the Business recipient rule.
//
//   GET  any member reads it (null = any recipient), plus canEdit/available
//   PUT  owner/admin, same origin, JSON; setting needs Business, clearing
//        never does; every change is a workspace_audit_events row
//   any other method is 405 from Next.js (not exported)
//
// Run: npm run test:recipient-rule
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000a1';

let signedIn = true;
let role: string | null = 'owner';
let plan: { resolved: boolean; plan?: string } = { resolved: true, plan: 'pro' };
let stored: string[] | null = null;
let workspaceExists = true;
let writeError: { message: string } | null = null;
let writes: Array<Record<string, unknown>> = [];
let auditEvents: Array<Record<string, unknown>> = [];

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER } : null }, error: signedIn ? null : { message: 'no' } }) },
    }),
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from(table: string) {
        assert.equal(table, 'workspaces');
        let patch: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {};
        const chain = () => b;
        Object.assign(b, {
          select: chain,
          eq: chain,
          is: chain,
          update: (p: Record<string, unknown>) => { patch = p; return b; },
          maybeSingle: async () => {
            if (patch) {
              if (writeError) return { data: null, error: writeError };
              writes.push(patch);
              stored = patch.allowed_recipient_domains as string[] | null;
            }
            return { data: workspaceExists ? { allowed_recipient_domains: stored } : null, error: null };
          },
        });
        return b;
      },
    }),
  },
});

nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => role,
    canManageWorkspace: (r: string | null) => r === 'owner' || r === 'admin',
  },
});

nodeMock.module('@/lib/plans/effective-plan', {
  namedExports: { resolveEffectiveWorkspacePlan: async () => plan },
});

nodeMock.module('@/lib/workspace/audit-events', {
  namedExports: {
    recordWorkspaceAuditEvent: async (_db: unknown, event: Record<string, unknown>) => {
      auditEvents.push(event);
      return true;
    },
  },
});

const route = await import('./route.ts');
const { NextRequest } = await import('next/server');

function reset(opts: { role?: string | null; plan?: string | null; stored?: string[] | null } = {}) {
  signedIn = true;
  role = opts.role === undefined ? 'owner' : opts.role;
  plan = opts.plan === null ? { resolved: false } : { resolved: true, plan: opts.plan ?? 'pro' };
  stored = opts.stored ?? null;
  workspaceExists = true;
  writeError = null;
  writes = [];
  auditEvents = [];
}

const ctx = (id = WS) => ({ params: Promise.resolve({ id }) });
const url = (id = WS) => new URL(`/api/workspaces/${id}/recipient-rule`, 'https://mcpemails.com');

function put(body: unknown, opts: { origin?: string | null; type?: string; id?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': opts.type ?? 'application/json' };
  if (opts.origin !== null) headers.origin = opts.origin ?? 'https://mcpemails.com';
  return route.PUT(
    new NextRequest(url(opts.id), { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ctx(opts.id),
  );
}

const get = (id = WS) => route.GET(new NextRequest(url(id)), ctx(id));

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

test('GET and PUT are the only exported methods (any other is 405 from Next.js)', () => {
  const mod = route as Record<string, unknown>;
  assert.equal(typeof mod.GET, 'function');
  assert.equal(typeof mod.PUT, 'function');
  for (const m of ['POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(mod[m], undefined, m);
});

test('GET: 401 signed out, 404 for a non-member or a malformed id', async () => {
  reset();
  signedIn = false;
  assert.equal((await get()).status, 401);
  reset({ role: null });
  assert.equal((await get()).status, 404);
  reset();
  assert.equal((await get('not-a-uuid')).status, 404);
});

test('GET: a member reads the rule but cannot edit it', async () => {
  reset({ role: 'member', stored: ['example.com'] });
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { domains: ['example.com'], canEdit: false, available: true });
});

test('GET: owner on a lower plan sees available false; no rule reads as null', async () => {
  reset({ plan: 'solo' });
  assert.deepEqual(await (await get()).json(), { domains: null, canEdit: true, available: false });
});

test('PUT: owner on Business sets a list, parsed and stored, and an audit row records from/to', async () => {
  reset();
  const res = await put({ domains: 'Example.com, @partner.no' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { domains: ['example.com', 'partner.no'] });
  assert.deepEqual(writes, [{ allowed_recipient_domains: ['example.com', 'partner.no'] }]);
  assert.equal(auditEvents.length, 1);
  assert.deepEqual(auditEvents[0], {
    workspaceId: WS,
    actorUserId: USER,
    kind: 'recipient_rule_changed',
    target: null,
    details: { to: ['example.com', 'partner.no'], to_count: 2, added: ['example.com', 'partner.no'], removed: [] },
  });
});

test('PUT: a 100-domain change is logged as a truncated diff that fits the row', async () => {
  const long = (i: number) => `d${i}.example`;
  reset({ stored: Array.from({ length: 100 }, (_, i) => long(i)) });
  const next = Array.from({ length: 100 }, (_, i) => long(i + 100));
  assert.equal((await put({ domains: next })).status, 200);
  const d = auditEvents[0].details as Record<string, unknown>;
  assert.equal((d.to as string[]).length, 15);
  assert.equal(d.to_count, 100);
  assert.equal(d.to_more, 85);
  assert.equal((d.added as string[]).length, 15);
  assert.equal(d.added_more, 85);
  assert.equal((d.removed as string[]).length, 15);
  assert.equal(d.removed_more, 85);
  assert.ok(Buffer.byteLength(JSON.stringify(d)) < 16384, 'fits the 16 KB cap');
});

test('PUT: an admin may set it too', async () => {
  reset({ role: 'admin' });
  assert.equal((await put({ domains: ['a.com'] })).status, 200);
});

test('PUT: empty clears the rule, on any plan', async () => {
  reset({ plan: 'free', stored: ['a.com'] });
  const res = await put({ domains: '' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { domains: null });
  assert.deepEqual(writes, [{ allowed_recipient_domains: null }]);
  assert.deepEqual(auditEvents[0].details, { to: null, to_count: 0, added: [], removed: ['a.com'] });
});

test('PUT: the same list again writes no audit row', async () => {
  reset({ stored: ['a.com'] });
  assert.equal((await put({ domains: 'a.com' })).status, 200);
  assert.equal(auditEvents.length, 0);
});

test('PUT: setting a rule off Business, or with the plan unreadable, is 403 and writes nothing', async () => {
  for (const p of ['solo', 'personal', 'free', null]) {
    reset({ plan: p });
    const res = await put({ domains: 'a.com' });
    assert.equal(res.status, 403, String(p));
    assert.equal((await res.json()).error_code, 'business_required');
    assert.equal(writes.length, 0);
  }
});

test('PUT: members and viewers are refused', async () => {
  for (const r of ['member', 'viewer']) {
    reset({ role: r });
    const res = await put({ domains: 'a.com' });
    assert.equal(res.status, 403, r);
    assert.equal(writes.length, 0);
  }
  reset({ role: null });
  assert.equal((await put({ domains: 'a.com' })).status, 404);
});

test('PUT: cross-origin, missing origin or non-JSON is refused before anything is read', async () => {
  reset();
  assert.equal((await put({ domains: 'a.com' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await put({ domains: 'a.com' }, { origin: null })).status, 403);
  assert.equal((await put('domains=a.com', { type: 'application/x-www-form-urlencoded' })).status, 403);
  assert.equal(writes.length, 0);
});

test('PUT: a bad body or an invalid domain is 400', async () => {
  reset();
  assert.equal((await put('{nope')).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put([])).status, 400);
  const res = await put({ domains: 'a.com, not a domain' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error_code, 'invalid_domains');
  assert.equal((await put({ domains: 7 })).status, 400);
  assert.equal(writes.length, 0);
});

test('PUT: a failed write is a 500 with no audit row', async () => {
  reset();
  writeError = { message: 'boom' };
  assert.equal((await quiet(() => put({ domains: 'a.com' }))).status, 500);
  assert.equal(auditEvents.length, 0);
});
