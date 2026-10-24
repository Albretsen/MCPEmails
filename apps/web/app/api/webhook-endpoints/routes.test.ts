// ---------------------------------------------------------------------------
// /api/webhook-endpoints: list, create, edit, re-enable, delete, test ping and
// the delivery log, end to end through the handlers, with every HTTP method.
//
// Stubbed: the two Supabase clients (one in-memory database behind both; the
// user client REFUSES writes and the secret column, as the migration's grants
// do, and sees only its own workspaces, as RLS does), next/headers,
// next/server, the rate limiter, the plan lookup and the outbound POST.
// Everything else (role and plan gates, the URL and SSRF checks, the secret's
// encryption, the 10-endpoint cap, the writes) is real.
//
// Run: npm run test:webhooks
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

process.env.ENCRYPTION_KEY = '3c'.repeat(32);

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;

const WS = '0a000000-0000-4000-8000-000000000001';
const OTHER_WS = '0a000000-0000-4000-8000-000000000002';
const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const OUTSIDER = 'u-outsider';
const INBOX_1 = '1b000000-0000-4000-8000-000000000001';
const INBOX_FOREIGN = '1b000000-0000-4000-8000-000000000009';
const EP_MINE = '2c000000-0000-4000-8000-000000000001';
const EP_FOREIGN = '2c000000-0000-4000-8000-000000000009';

const world = {
  user: null as { id: string } | null,
  plan: 'solo' as string | null,
  rateLimited: false,
  db: {} as Record<string, Row[]>,
  writes: [] as string[],
  posts: [] as Array<{ url: string; headers: Record<string, string>; body: string }>,
  postAnswer: { kind: 'response', status: 204 } as { kind: 'response'; status: number } | { kind: 'error'; code: string },
};

function endpointRow(id: string, workspaceId: string, extra: Row = {}): Row {
  return {
    id,
    workspace_id: workspaceId,
    url: 'https://93.184.216.34/hooks',
    secret_ciphertext: 'not-a-real-ciphertext',
    secret_prefix: 'whsec_abcdef',
    inbox_ids: null,
    events: ['message.received'],
    payload_mode: 'ids',
    created_by: OWNER,
    created_at: '2026-10-20T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
    disabled_at: null,
    disabled_reason: null,
    consecutive_failures: 0,
    failing_since: null,
    last_success_at: null,
    ...extra,
  };
}

function seed() {
  world.db = {
    workspace_members: [
      { workspace_id: WS, user_id: OWNER, role: 'owner', joined_at: '2026-01-01' },
      { workspace_id: WS, user_id: ADMIN, role: 'admin', joined_at: '2026-01-02' },
      { workspace_id: WS, user_id: MEMBER, role: 'member', joined_at: '2026-01-03' },
      { workspace_id: OTHER_WS, user_id: OUTSIDER, role: 'owner', joined_at: '2026-01-01' },
    ],
    inboxes: [
      { id: INBOX_1, workspace_id: WS, deleted_at: null },
      { id: INBOX_FOREIGN, workspace_id: OTHER_WS, deleted_at: null },
    ],
    webhook_endpoints: [endpointRow(EP_MINE, WS), endpointRow(EP_FOREIGN, OTHER_WS)],
    webhook_deliveries: [
      { id: 'd-1', endpoint_id: EP_MINE, workspace_id: WS, event_id: `evt_${'1'.repeat(32)}`, event_type: 'message.received', inbox_id: INBOX_1, message_ids: ['INBOX:1'], message_count: 1, attempt: 1, status: 'pending', response_code: 500, error_code: 'http_status', next_attempt_at: '2026-10-24T00:01:00.000Z', lease_id: null, leased_until: null, created_at: '2026-10-24T00:00:00.000Z', last_attempt_at: '2026-10-24T00:00:00.000Z', delivered_at: null },
      { id: 'd-9', endpoint_id: EP_FOREIGN, workspace_id: OTHER_WS, event_id: `evt_${'9'.repeat(32)}`, event_type: 'message.received', inbox_id: INBOX_FOREIGN, message_ids: null, message_count: 1, attempt: 1, status: 'delivered', response_code: 200, error_code: null, next_attempt_at: null, lease_id: null, leased_until: null, created_at: '2026-10-24T00:00:00.000Z', last_attempt_at: null, delivered_at: null },
    ],
  };
}

let nextId = 1;

function fakeClient(kind: 'user' | 'service') {
  const mine = () => world.db.workspace_members.filter((m) => m.user_id === world.user?.id).map((m) => m.workspace_id);
  return {
    auth: { getUser: async () => ({ data: { user: world.user }, error: null }) },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row | null = null;
      let returning = false;
      let head = false;
      let columns = '*';
      let limit: number | null = null;
      const b: Record<string, unknown> = {};
      b.select = (cols?: string, opts?: { head?: boolean }) => {
        if (op === 'select') {
          head = opts?.head === true;
          columns = cols ?? '*';
        } else returning = true;
        return b;
      };
      b.insert = (row: Row) => ((op = 'insert'), (payload = row), b);
      b.update = (row: Row) => ((op = 'update'), (payload = row), b);
      b.delete = () => ((op = 'delete'), b);
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
      b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
      b.order = () => b;
      b.limit = (n: number) => ((limit = n), b);

      const rows = () => (world.db[table] ??= []);
      const visible = (r: Row) =>
        kind === 'service' || !table.startsWith('webhook_') || mine().includes(r.workspace_id as string);
      const matching = () => rows().filter((r) => visible(r) && filters.every((f) => f(r)));

      const run = (): { data: unknown; error: unknown; count?: number } => {
        if (op !== 'select') {
          world.writes.push(`${kind}:${op}:${table}`);
          if (kind === 'user' && table.startsWith('webhook_')) {
            return { data: null, error: { code: '42501', message: `permission denied for table ${table}` } };
          }
        }
        if (op === 'select' && kind === 'user' && table === 'webhook_endpoints' && /secret_ciphertext|\*/.test(columns)) {
          return { data: null, error: { code: '42501', message: 'permission denied for column secret_ciphertext' } };
        }
        if (op === 'insert') {
          const row = { id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, created_at: '2026-10-24T12:00:00.000Z', updated_at: '2026-10-24T12:00:00.000Z', disabled_at: null, disabled_reason: null, consecutive_failures: 0, failing_since: null, last_success_at: null, events: ['message.received'], ...payload };
          rows().push(row);
          return { data: returning ? [row] : null, error: null };
        }
        if (op === 'update') {
          const hit = matching();
          for (const r of hit) Object.assign(r, payload);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (op === 'delete') {
          const hit = matching();
          world.db[table] = rows().filter((r) => !hit.includes(r));
          if (table === 'webhook_endpoints') {
            world.db.webhook_deliveries = world.db.webhook_deliveries.filter((d) => !hit.some((h) => h.id === d.endpoint_id));
          }
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        let out = matching().map((r) => ({ ...r }));
        if (head) return { data: null, error: null, count: out.length };
        if (limit != null) out = out.slice(0, limit);
        return { data: out, error: null, count: out.length };
      };
      b.single = async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        const list = (data as Row[] | null) ?? [];
        return list.length === 1 ? { data: list[0], error: null } : { data: null, error: { code: 'PGRST116' } };
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
  namedExports: { cookies: async () => ({ get: () => undefined }) },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});
nodeMock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => world.rateLimited } });
nodeMock.module('@/lib/plans/effective-plan', {
  namedExports: {
    resolveEffectiveWorkspacePlan: async () => {
      if (world.plan === null) return { resolved: false, reason: null };
      const { getPlanLimits } = await import('../../../src/lib/stripe/plans.ts');
      return { resolved: true, plan: world.plan, limits: getPlanLimits(world.plan), compedScale: false, unlimitedInboxes: false, proUnlimitedInboxes: false };
    },
  },
});
nodeMock.module('@/lib/webhooks/send', {
  namedExports: {
    postWebhook: async (options: { url: string; headers: Record<string, string>; body: string }) => {
      world.posts.push(options);
      return world.postAnswer;
    },
  },
});

const listRoute = (await import('./route.ts')) as unknown as { GET: () => Promise<Response>; POST: (r: Request) => Promise<Response> };
const itemRoute = (await import('./[id]/route.ts')) as unknown as {
  PATCH: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
  DELETE: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
};
const testRoute = (await import('./[id]/test/route.ts')) as unknown as {
  POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
};
const deliveriesRoute = (await import('./[id]/deliveries/route.ts')) as unknown as {
  GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
};
const { decryptToken, encryptToken } = await import('../../../src/lib/crypto.ts');
const { verifySignature } = await import('../../../src/lib/webhooks/sign.ts');

beforeEach(() => {
  seed();
  world.user = null;
  world.plan = 'solo';
  world.rateLimited = false;
  world.writes = [];
  world.posts = [];
  world.postAnswer = { kind: 'response', status: 204 };
});

const as = (id: string) => void (world.user = { id });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request('https://mcpemails.test/api/webhook-endpoints', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const create = (body: unknown) => listRoute.POST(json('POST', body));
const patch = (id: string, body: unknown) => itemRoute.PATCH(json('PATCH', body), ctx(id));
const del = (id: string) => itemRoute.DELETE(json('DELETE'), ctx(id));
const ping = (id: string) => testRoute.POST(json('POST'), ctx(id));
const deliveries = (id: string) => deliveriesRoute.GET(json('GET'), ctx(id));
const endpoint = (id: string) => world.db.webhook_endpoints.find((e) => e.id === id)!;

test('every route refuses an anonymous caller', async () => {
  assert.equal((await listRoute.GET()).status, 401);
  assert.equal((await create({ url: 'https://93.184.216.34/h' })).status, 401);
  assert.equal((await patch(EP_MINE, { enabled: false })).status, 401);
  assert.equal((await del(EP_MINE)).status, 401);
  assert.equal((await ping(EP_MINE)).status, 401);
  assert.equal((await deliveries(EP_MINE)).status, 401);
  assert.deepEqual(world.writes, []);
});

test('GET lists the active workspace\'s endpoints for any member, without the secret', async () => {
  as(MEMBER);
  const res = await listRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.endpoints.map((e: Row) => e.id), [EP_MINE]);
  assert.equal(body.canManage, false);
  assert.equal(body.webhooksEnabled, true);
  assert.equal(body.maxEndpoints, 10);
  assert.ok(!JSON.stringify(body).includes('ciphertext'));
});

test('GET on a Free workspace still lists (paused) endpoints and says webhooks are off', async () => {
  as(OWNER);
  world.plan = 'free';
  const body = await (await listRoute.GET()).json();
  assert.equal(body.webhooksEnabled, false);
  assert.equal(body.endpoints.length, 1);
});

test('POST creates an endpoint for an owner on Pro, stores the secret encrypted, and returns it once', async () => {
  as(OWNER);
  const res = await create({ url: 'https://93.184.216.34:8443/in?x=1', payloadMode: 'headers', inboxIds: [INBOX_1] });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(body.secretPrefix, body.secret.slice(0, 12));
  assert.equal(body.payloadMode, 'headers');
  assert.deepEqual(body.inboxIds, [INBOX_1]);
  const row = endpoint(body.id);
  assert.notEqual(row.secret_ciphertext, body.secret);
  assert.ok(!String(row.secret_ciphertext).includes(body.secret.slice(6)));
  assert.equal(decryptToken(row.secret_ciphertext as string), body.secret);
  assert.equal(row.workspace_id, WS);
  assert.equal(row.created_by, OWNER);
  assert.deepEqual(world.writes, ['service:insert:webhook_endpoints']);
});

test('POST on Business works too; Free and Personal get plan_required', async () => {
  as(ADMIN);
  world.plan = 'pro';
  assert.equal((await create({ url: 'https://93.184.216.34/a' })).status, 201);
  for (const plan of ['free', 'personal', null]) {
    world.plan = plan;
    const res = await create({ url: 'https://93.184.216.34/b' });
    assert.equal(res.status, 403, String(plan));
    assert.equal((await res.json()).error_code, 'plan_required');
  }
});

test('POST is owner/admin only', async () => {
  as(MEMBER);
  const res = await create({ url: 'https://93.184.216.34/a' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error_code, 'insufficient_role');
  assert.deepEqual(world.writes, []);
});

test('POST refuses http, odd ports, credentials and private addresses', async () => {
  as(OWNER);
  const cases: Array<[string, string]> = [
    ['http://93.184.216.34/a', 'url_not_https'],
    ['https://93.184.216.34:8080/a', 'port_not_allowed'],
    ['https://u:p@93.184.216.34/a', 'url_credentials'],
    ['https://127.0.0.1/a', 'host_not_allowed'],
    ['https://169.254.169.254/latest', 'host_not_allowed'],
    ['https://10.0.0.1/a', 'host_not_allowed'],
    ['https://[::1]/a', 'host_not_allowed'],
    ['https://2130706433/a', 'host_not_allowed'],
    ['not a url', 'url_invalid'],
  ];
  for (const [url, code] of cases) {
    const res = await create({ url });
    assert.equal(res.status, 400, url);
    assert.equal((await res.json()).error_code, code, url);
  }
  assert.deepEqual(world.writes, []);
});

test('POST refuses another workspace\'s inbox, an empty selection and an unknown payload mode', async () => {
  as(OWNER);
  assert.equal((await create({ url: 'https://93.184.216.34/a', inboxIds: [INBOX_FOREIGN] })).status, 400);
  assert.equal((await create({ url: 'https://93.184.216.34/a', inboxIds: [] })).status, 400);
  assert.equal((await create({ url: 'https://93.184.216.34/a', payloadMode: 'full' })).status, 400);
  assert.deepEqual(world.writes, []);
});

test('POST stops at 10 endpoints per workspace, and is rate limited', async () => {
  as(OWNER);
  for (let n = 0; n < 9; n++) world.db.webhook_endpoints.push(endpointRow(`2c000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`, WS));
  const res = await create({ url: 'https://93.184.216.34/a' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error_code, 'endpoint_limit');
  world.db.webhook_endpoints.pop();
  world.rateLimited = true;
  assert.equal((await create({ url: 'https://93.184.216.34/a' })).status, 429);
});

test('PATCH re-enables a disabled endpoint and clears its failure run', async () => {
  as(ADMIN);
  Object.assign(endpoint(EP_MINE), { disabled_at: '2026-10-23T00:00:00.000Z', disabled_reason: 'failing', consecutive_failures: 50, failing_since: '2026-10-22T00:00:00.000Z' });
  const res = await patch(EP_MINE, { enabled: true });
  assert.equal(res.status, 200);
  const row = endpoint(EP_MINE);
  assert.equal(row.disabled_at, null);
  assert.equal(row.disabled_reason, null);
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.failing_since, null);
});

test('PATCH edits url, inboxes and payload mode; turning off is "manual"', async () => {
  as(OWNER);
  assert.equal((await patch(EP_MINE, { url: 'https://93.184.216.35/new', inboxIds: [INBOX_1], payloadMode: 'headers' })).status, 200);
  assert.equal(endpoint(EP_MINE).url, 'https://93.184.216.35/new');
  assert.deepEqual(endpoint(EP_MINE).inbox_ids, [INBOX_1]);
  assert.equal(endpoint(EP_MINE).payload_mode, 'headers');
  assert.equal((await patch(EP_MINE, { inboxIds: null })).status, 200);
  assert.equal(endpoint(EP_MINE).inbox_ids, null);
  assert.equal((await patch(EP_MINE, { enabled: false })).status, 200);
  assert.equal(endpoint(EP_MINE).disabled_reason, 'manual');
  assert.equal((await patch(EP_MINE, { url: 'https://192.168.0.1/x' })).status, 400);
  assert.equal((await patch(EP_MINE, {})).status, 400);
});

test('PATCH: a downgraded workspace may turn an endpoint off but not back on', async () => {
  as(OWNER);
  world.plan = 'personal';
  assert.equal((await patch(EP_MINE, { enabled: false })).status, 200);
  const res = await patch(EP_MINE, { enabled: true });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error_code, 'plan_required');
});

test('PATCH and DELETE never reach another workspace\'s endpoint, and members cannot use them', async () => {
  as(OWNER);
  assert.equal((await patch(EP_FOREIGN, { enabled: false })).status, 404);
  assert.equal((await del(EP_FOREIGN)).status, 404);
  assert.equal(endpoint(EP_FOREIGN).disabled_at, null);
  as(MEMBER);
  assert.equal((await patch(EP_MINE, { enabled: false })).status, 403);
  assert.equal((await del(EP_MINE)).status, 403);
  assert.equal((await patch('not-a-uuid', { enabled: false })).status, 404);
});

test('DELETE removes the endpoint and its delivery log', async () => {
  as(OWNER);
  world.plan = 'free';
  assert.equal((await del(EP_MINE)).status, 200);
  assert.equal(world.db.webhook_endpoints.some((e) => e.id === EP_MINE), false);
  assert.equal(world.db.webhook_deliveries.some((d) => d.endpoint_id === EP_MINE), false);
  assert.equal((await del(EP_MINE)).status, 404);
});

test('the test ping is signed with the endpoint\'s secret, reports the status, and is logged', async () => {
  as(OWNER);
  const secret = `whsec_${'7'.repeat(64)}`;
  endpoint(EP_MINE).secret_ciphertext = encryptToken(secret);
  world.postAnswer = { kind: 'response', status: 503 };
  const res = await ping(EP_MINE);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.ok, body.status, body.errorCode], [false, 503, 'http_status']);
  assert.equal(world.posts.length, 1);
  const sent = world.posts[0];
  assert.equal(sent.url, 'https://93.184.216.34/hooks');
  const event = JSON.parse(sent.body);
  assert.equal(event.type, 'ping');
  assert.equal(event.endpoint_id, EP_MINE);
  assert.equal(sent.headers['MCPEmails-Event-Id'], event.id);
  assert.ok(verifySignature(sent.headers['MCPEmails-Signature'], secret, sent.body, Math.floor(Date.now() / 1000)));
  const logged = world.db.webhook_deliveries.find((d) => d.event_id === event.id)!;
  assert.deepEqual([logged.event_type, logged.status, logged.response_code, logged.attempt], ['ping', 'failed', 503, 1]);
  assert.equal(endpoint(EP_MINE).consecutive_failures, 0, 'a ping never counts toward auto-disable');
});

test('the test ping is owner/admin, plan-gated, workspace-scoped and rate limited', async () => {
  as(MEMBER);
  assert.equal((await ping(EP_MINE)).status, 403);
  as(OWNER);
  assert.equal((await ping(EP_FOREIGN)).status, 404);
  world.plan = 'free';
  assert.equal((await ping(EP_MINE)).status, 403);
  world.plan = 'solo';
  world.rateLimited = true;
  assert.equal((await ping(EP_MINE)).status, 429);
  assert.equal(world.posts.length, 0);
});

test('deliveries: any member reads their endpoint\'s log, without message ids; never another workspace\'s', async () => {
  as(MEMBER);
  const res = await deliveries(EP_MINE);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.deliveries.map((d: Row) => d.id), ['d-1']);
  assert.equal(body.deliveries[0].responseCode, 500);
  assert.ok(!JSON.stringify(body).includes('INBOX:1'), 'pending message ids are not returned');
  assert.equal((await deliveries(EP_FOREIGN)).status, 404);
  as(OUTSIDER);
  assert.equal((await deliveries(EP_MINE)).status, 404);
});
