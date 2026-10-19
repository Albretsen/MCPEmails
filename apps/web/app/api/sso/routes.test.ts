// ---------------------------------------------------------------------------
// app/api/sso/**: who may manage SSO, and that nothing leaks across
// workspaces.
//
//   - no session                 -> 401 on every route
//   - member / viewer            -> 403 insufficient_role, and the service-role
//                                   client, the Management API and DNS are
//                                   never touched
//   - not on the enterprise plan -> 403 plan_required, same guarantees
//   - another workspace          -> the active-workspace cookie cannot select a
//                                   workspace the caller is not in, the role is
//                                   the one in the ACTIVE workspace, and a
//                                   domain id from another workspace is a 404
//                                   with that row untouched
//   - owner/admin on enterprise  -> the happy paths, each writing an audit row
//
// Only I/O is stubbed: both Supabase clients share one in-memory world, the
// Management API and the DNS check are recorded stubs.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/sso/routes.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-0000000000a1', email: 'admin@company-sso.example' };
const WS = '11111111-1111-4111-8111-111111111111';
const WS_OTHER = '22222222-2222-4222-8222-222222222222';
const PROVIDER = '33333333-3333-4333-8333-333333333333';
const TOKEN = '0123456789abcdef0123456789abcdef';
const METADATA =
  'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/federationmetadata/2007-06/federationmetadata.xml?appid=44444444-4444-4444-4444-444444444444';

type Row = Record<string, unknown>;

interface Call {
  client: 'user' | 'service';
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  filters: Array<[string, unknown]>;
  payload: unknown;
}

interface World {
  signedIn: boolean;
  /** USER's role per workspace. */
  roles: Record<string, string>;
  plans: Record<string, string>;
  cookie: string | null;
  tables: { sso_connections: Row[]; sso_domains: Row[]; sso_audit_events: Row[]; users: Row[] };
  testSeen: boolean;
  dns: { verified: true } | { verified: false; reason: string };
  verifyConflict: boolean;
  calls: Call[];
  mgmt: Array<{ op: string; args: unknown[] }>;
  dnsChecks: string[];
}

let world: World;
let seq = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12, '0')}`;

function connectionRow(over: Row = {}): Row {
  return {
    id: uuid(),
    workspace_id: WS,
    supabase_sso_provider_id: PROVIDER,
    display_name: 'Microsoft Entra ID',
    status: 'active',
    enforced: false,
    default_role: 'member',
    created_by: USER.id,
    created_at: '2026-10-19T10:00:00Z',
    updated_at: '2026-10-19T10:00:00Z',
    ...over,
  };
}

function domainRow(connection: Row, over: Row = {}): Row {
  return {
    id: uuid(),
    connection_id: connection.id,
    workspace_id: connection.workspace_id,
    domain: 'company-sso.example',
    verification_token: TOKEN,
    verified_at: null,
    created_at: '2026-10-19T10:00:00Z',
    updated_at: '2026-10-19T10:00:00Z',
    ...over,
  };
}

function reset(over: Partial<World> = {}): void {
  world = {
    signedIn: true,
    roles: { [WS]: 'admin' },
    plans: { [WS]: 'enterprise', [WS_OTHER]: 'enterprise' },
    cookie: WS,
    tables: { sso_connections: [], sso_domains: [], sso_audit_events: [], users: [{ id: USER.id, email: USER.email }] },
    testSeen: false,
    dns: { verified: true },
    verifyConflict: false,
    calls: [],
    mgmt: [],
    dnsChecks: [],
    ...over,
  };
}

// ── Fake Supabase ────────────────────────────────────────────────────────────

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([col, val]) =>
    Array.isArray(val) && col.startsWith('in:') ? val.includes(row[col.slice(3)]) : row[col] === val,
  );
}

function runQuery(call: Call, mode: 'many' | 'maybe' | 'single'): { data: unknown; error: unknown } {
  world.calls.push(call);

  if (call.client === 'user') {
    if (call.table !== 'workspace_members' || call.op !== 'select') {
      return { data: null, error: { code: '42501', message: `user client may not ${call.op} ${call.table}` } };
    }
    const userId = call.filters.find(([c]) => c === 'user_id')?.[1];
    const wsId = call.filters.find(([c]) => c === 'workspace_id')?.[1];
    const rows = userId === USER.id
      ? Object.entries(world.roles)
          .filter(([ws]) => wsId === undefined || ws === wsId)
          .map(([ws, role]) => ({ workspace_id: ws, role, joined_at: '2026-01-01T00:00:00Z' }))
      : [];
    return { data: mode === 'many' ? rows : (rows[0] ?? null), error: null };
  }

  const table = world.tables[call.table as keyof World['tables']];
  if (!table) return { data: null, error: { message: `unknown table ${call.table}` } };
  let result: Row[];
  if (call.op === 'insert') {
    const row: Row = { id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(call.payload as Row) };
    if (call.table === 'sso_connections') {
      row.status ??= 'draft';
      row.enforced ??= false;
      row.supabase_sso_provider_id ??= null;
    }
    if (call.table === 'sso_domains') {
      const conn = world.tables.sso_connections.find((c) => c.id === row.connection_id);
      row.workspace_id = conn?.workspace_id;
      row.verification_token ??= TOKEN;
      row.verified_at ??= null;
    }
    table.push(row);
    result = [row];
  } else if (call.op === 'update') {
    const patch = call.payload as Row;
    if (call.table === 'sso_domains' && 'verified_at' in patch && world.verifyConflict) {
      return { data: null, error: { code: '23505', message: 'duplicate key sso_domains_verified_domain_key' } };
    }
    result = table.filter((r) => matches(r, call.filters));
    for (const r of result) Object.assign(r, patch);
  } else if (call.op === 'delete') {
    result = table.filter((r) => matches(r, call.filters));
    for (const r of result) table.splice(table.indexOf(r), 1);
  } else {
    result = table.filter((r) => matches(r, call.filters));
  }
  if (mode === 'many') return { data: result.map((r) => ({ ...r })), error: null };
  if (mode === 'single' && result.length !== 1) return { data: null, error: { message: 'expected one row' } };
  return { data: result[0] ? { ...result[0] } : null, error: null };
}

function client(kind: 'user' | 'service') {
  return {
    from(table: string) {
      const call: Call = { client: kind, table, op: 'select', filters: [], payload: null };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.insert = (payload: unknown) => { call.op = 'insert'; call.payload = payload; return builder; };
      builder.update = (payload: unknown) => { call.op = 'update'; call.payload = payload; return builder; };
      builder.delete = () => { call.op = 'delete'; return builder; };
      builder.eq = (col: string, val: unknown) => { call.filters.push([col, val]); return builder; };
      builder.in = (col: string, vals: unknown[]) => { call.filters.push([`in:${col}`, vals]); return builder; };
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = async () => runQuery(call, 'maybe');
      builder.single = async () => runQuery(call, 'single');
      builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve().then(() => runQuery(call, 'many')).then(ok, ko);
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      world.calls.push({ client: kind, table: fn, op: 'rpc', filters: Object.entries(args), payload: null });
      if (fn === 'effective_workspace_plan' && kind === 'user') {
        const ws = args.p_workspace_id as string;
        // RLS-gated on the caller, like the real RPC.
        if (!world.roles[ws]) return { data: [], error: null };
        return { data: [{ plan: world.plans[ws] ?? 'free', comped_scale: false, unlimited_inboxes: false }], error: null };
      }
      if (fn === 'sso_admin_test_sign_in_seen' && kind === 'service') return { data: world.testSeen, error: null };
      return { data: null, error: { message: `unexpected rpc ${fn} on ${kind}` } };
    },
    auth: {
      getUser: async () => (world.signedIn
        ? { data: { user: USER }, error: null }
        : { data: { user: null }, error: { message: 'no session' } }),
    },
  };
}

class FakeManagementError extends Error {
  reason: string;
  status: number | null;
  constructor(reason: string, status: number | null) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => client('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client('service') } });
nodeMock.module('next/headers', {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === 'mcpe_active_ws' && world.cookie ? { value: world.cookie } : undefined) }),
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});
nodeMock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => false } });
nodeMock.module('@/lib/sso/management-api', {
  namedExports: {
    SsoManagementError: FakeManagementError,
    isSsoManagementConfigured: () => true,
    createSamlProvider: async (...args: unknown[]) => { world.mgmt.push({ op: 'create', args }); return PROVIDER; },
    updateSamlProvider: async (...args: unknown[]) => { world.mgmt.push({ op: 'update', args }); },
    deleteSamlProvider: async (...args: unknown[]) => { world.mgmt.push({ op: 'delete', args }); },
  },
});
nodeMock.module('@/lib/sso/dns-verify', {
  namedExports: {
    checkDomainVerificationRecord: async (domain: string) => { world.dnsChecks.push(domain); return world.dns; },
  },
});

const ssoRoute = await import('./route.ts');
const connectionRoute = await import('./connection/route.ts');
const domainsRoute = await import('./domains/route.ts');
const domainRoute = await import('./domains/[id]/route.ts');
const verifyRoute = await import('./domains/[id]/verify/route.ts');

const BASE = 'https://mcpemails.test/api/sso';
const json = (method: string, url: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** Every route and method, with a plausible body. */
function everyCall(domainId = uuid()): Array<[string, () => Promise<Response>]> {
  return [
    ['GET /api/sso', () => ssoRoute.GET()],
    ['PUT /api/sso/connection', () => connectionRoute.PUT(json('PUT', `${BASE}/connection`, { metadataUrl: METADATA }))],
    ['PATCH /api/sso/connection enforced', () => connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { enforced: true }))],
    ['PATCH /api/sso/connection enabled', () => connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { enabled: false }))],
    ['PATCH /api/sso/connection defaultRole', () => connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { defaultRole: 'viewer' }))],
    ['POST /api/sso/domains', () => domainsRoute.POST(json('POST', `${BASE}/domains`, { domain: 'company-sso.example' }))],
    ['DELETE /api/sso/domains/[id]', () => domainRoute.DELETE(json('DELETE', `${BASE}/domains/${domainId}`), idParams(domainId))],
    ['POST /api/sso/domains/[id]/verify', () => verifyRoute.POST(json('POST', `${BASE}/domains/${domainId}/verify`), idParams(domainId))],
  ];
}

const serviceCalls = () => world.calls.filter((c) => c.client === 'service');

function assertNothingTouched(label: string): void {
  assert.deepEqual(serviceCalls(), [], `${label}: no service-role call`);
  assert.deepEqual(world.mgmt, [], `${label}: no Management API call`);
  assert.deepEqual(world.dnsChecks, [], `${label}: no DNS lookup`);
}

beforeEach(() => reset());

// ── Exported methods ─────────────────────────────────────────────────────────

test('each route exports only its methods (anything else is 405 from Next)', () => {
  const methods = (mod: Record<string, unknown>) =>
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter((m) => typeof mod[m] === 'function');
  assert.deepEqual(methods(ssoRoute), ['GET']);
  assert.deepEqual(methods(connectionRoute), ['PUT', 'PATCH']);
  assert.deepEqual(methods(domainsRoute), ['POST']);
  assert.deepEqual(methods(domainRoute), ['DELETE']);
  assert.deepEqual(methods(verifyRoute), ['POST']);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('no session: 401 on every route, nothing touched', async () => {
  for (const [label, call] of everyCall()) {
    reset({ signedIn: false });
    const res = await call();
    assert.equal(res.status, 401, label);
    assertNothingTouched(label);
  }
});

for (const role of ['member', 'viewer']) {
  test(`${role}: 403 insufficient_role on every route, nothing touched`, async () => {
    for (const [label, call] of everyCall()) {
      reset({ roles: { [WS]: role } });
      world.tables.sso_connections.push(connectionRow());
      const res = await call();
      assert.equal(res.status, 403, label);
      assert.equal((await res.json()).error_code, 'insufficient_role', label);
      assertNothingTouched(label);
    }
  });
}

test('no workspace at all: 403, nothing touched', async () => {
  for (const [label, call] of everyCall()) {
    reset({ roles: {}, cookie: WS_OTHER });
    const res = await call();
    assert.equal(res.status, 403, label);
    assertNothingTouched(label);
  }
});

test('owner without the enterprise plan: 403 plan_required, nothing touched', async () => {
  for (const plan of ['free', 'personal', 'solo', 'pro']) {
    for (const [label, call] of everyCall()) {
      reset({ roles: { [WS]: 'owner' }, plans: { [WS]: plan } });
      const res = await call();
      assert.equal(res.status, 403, `${plan} ${label}`);
      assert.equal((await res.json()).error_code, 'plan_required', `${plan} ${label}`);
      assertNothingTouched(`${plan} ${label}`);
    }
  }
});

// ── Other workspaces ─────────────────────────────────────────────────────────

test('other workspace: a cookie for a workspace the caller is not in falls back to their own', async () => {
  reset({ cookie: WS_OTHER });
  const other = connectionRow({ workspace_id: WS_OTHER, supabase_sso_provider_id: '55555555-5555-4555-8555-555555555555' });
  world.tables.sso_connections.push(other);

  const res = await ssoRoute.GET();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).connection, null, 'the other workspace\'s connection is not shown');

  const add = await domainsRoute.POST(json('POST', `${BASE}/domains`, { domain: 'company-sso.example' }));
  assert.equal(add.status, 201);
  const created = world.tables.sso_connections.filter((c) => c !== other);
  assert.equal(created.length, 1);
  assert.equal(created[0].workspace_id, WS, 'the draft is created in the caller\'s workspace');
  for (const c of serviceCalls().filter((c) => c.op !== 'insert' && c.table !== 'users')) {
    assert.ok(c.filters.some(([col, v]) => col === 'workspace_id' && v === WS), `${c.op} ${c.table} scoped to WS`);
  }
});

test('other workspace: admin here, viewer there, acting there is refused', async () => {
  reset({ roles: { [WS]: 'admin', [WS_OTHER]: 'viewer' }, cookie: WS_OTHER });
  for (const [label, call] of everyCall()) {
    world.calls = [];
    const res = await call();
    assert.equal(res.status, 403, label);
    assertNothingTouched(label);
  }
});

test('other workspace: a domain id from another workspace is a 404 and that row is untouched', async () => {
  const other = connectionRow({ workspace_id: WS_OTHER });
  const otherDomain = domainRow(other);
  world.tables.sso_connections.push(other, connectionRow());
  world.tables.sso_domains.push(otherDomain);
  const before = { ...otherDomain };

  const del = await domainRoute.DELETE(json('DELETE', `${BASE}/domains/${otherDomain.id}`), idParams(String(otherDomain.id)));
  assert.equal(del.status, 404);
  const verify = await verifyRoute.POST(json('POST', `${BASE}/domains/${otherDomain.id}/verify`), idParams(String(otherDomain.id)));
  assert.equal(verify.status, 404);

  assert.deepEqual(world.tables.sso_domains, [before]);
  assert.deepEqual(world.dnsChecks, []);
  assert.equal(world.tables.sso_audit_events.length, 0);
});

// ── Happy paths (owner/admin on enterprise) ─────────────────────────────────

test('GET returns our SAML values and state, never the provider id', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
  const conn = connectionRow();
  world.tables.sso_connections.push(conn);
  world.tables.sso_domains.push(domainRow(conn));
  const res = await ssoRoute.GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.saml.acsUrl, 'https://abcdefghijklmnopqrst.supabase.co/auth/v1/sso/saml/acs');
  assert.equal(body.connection.hasProvider, true);
  assert.equal(body.domains[0].txtRecord, `mcpemails-verification=${TOKEN}`);
  assert.ok(!JSON.stringify(body).includes(PROVIDER), 'provider id stays server-side');
});

test('PUT creates the provider, an active connection and an audit row', async () => {
  const res = await connectionRoute.PUT(json('PUT', `${BASE}/connection`, { metadataUrl: METADATA }));
  assert.equal(res.status, 200);
  assert.deepEqual(world.mgmt.map((m) => m.op), ['create']);
  assert.equal(world.tables.sso_connections.length, 1);
  assert.equal(world.tables.sso_connections[0].status, 'active');
  assert.equal(world.tables.sso_connections[0].supabase_sso_provider_id, PROVIDER);
  assert.deepEqual(world.tables.sso_audit_events.map((e) => e.action), ['connection.created']);
  assert.equal(world.tables.sso_audit_events[0].actor_user_id, USER.id);
});

test('PUT with a non-Entra URL is refused before the Management API', async () => {
  const res = await connectionRoute.PUT(json('PUT', `${BASE}/connection`, { metadataUrl: 'https://idp.example.test/metadata.xml' }));
  assert.equal(res.status, 400);
  assert.deepEqual(world.mgmt, []);
});

test('PUT on an existing provider updates it in place', async () => {
  world.tables.sso_connections.push(connectionRow());
  const res = await connectionRoute.PUT(json('PUT', `${BASE}/connection`, { metadataUrl: METADATA }));
  assert.equal(res.status, 200);
  assert.deepEqual(world.mgmt.map((m) => m.op), ['update']);
  assert.deepEqual(world.tables.sso_audit_events.map((e) => e.action), ['connection.metadata_updated']);
});

test('POST domain: consumer domains refused, a company domain is added pending and audited', async () => {
  const consumer = await domainsRoute.POST(json('POST', `${BASE}/domains`, { domain: 'gmail.com' }));
  assert.equal(consumer.status, 400);
  assert.equal((await consumer.json()).error_code, 'consumer_domain');

  const res = await domainsRoute.POST(json('POST', `${BASE}/domains`, { domain: 'Company-SSO.example' }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.domain.domain, 'company-sso.example');
  assert.equal(body.domain.verified, false);
  assert.deepEqual(world.tables.sso_audit_events.map((e) => e.action), ['connection.created', 'domain.added']);

  const dup = await domainsRoute.POST(json('POST', `${BASE}/domains`, { domain: 'company-sso.example' }));
  assert.equal(dup.status, 409);
});

test('verify: missing record leaves it pending; a found record verifies and audits', async () => {
  const conn = connectionRow();
  const d = domainRow(conn);
  world.tables.sso_connections.push(conn);
  world.tables.sso_domains.push(d);

  world.dns = { verified: false, reason: 'record_missing' };
  const miss = await verifyRoute.POST(json('POST', `${BASE}/domains/${d.id}/verify`), idParams(String(d.id)));
  assert.equal(miss.status, 422);
  assert.equal(world.tables.sso_domains[0].verified_at, null);
  assert.equal(world.tables.sso_audit_events.length, 0);

  world.dns = { verified: true };
  const hit = await verifyRoute.POST(json('POST', `${BASE}/domains/${d.id}/verify`), idParams(String(d.id)));
  assert.equal(hit.status, 200);
  assert.equal((await hit.json()).domain.verified, true);
  assert.ok(world.tables.sso_domains[0].verified_at);
  assert.deepEqual(world.dnsChecks, ['company-sso.example', 'company-sso.example']);
  assert.deepEqual(world.tables.sso_audit_events.map((e) => e.action), ['domain.verified']);
  const update = serviceCalls().find((c) => c.table === 'sso_domains' && c.op === 'update');
  assert.ok(update?.filters.some(([col, v]) => col === 'verification_token' && v === TOKEN), 'conditioned on the checked token');
});

test('verify: a domain already verified by another workspace is 409 domain_taken', async () => {
  const conn = connectionRow();
  const d = domainRow(conn);
  world.tables.sso_connections.push(conn);
  world.tables.sso_domains.push(d);
  world.verifyConflict = true;
  const res = await verifyRoute.POST(json('POST', `${BASE}/domains/${d.id}/verify`), idParams(String(d.id)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error_code, 'domain_taken');
  assert.equal(world.tables.sso_audit_events.length, 0);
});

test('enforce stays locked until a verified domain AND an admin test sign-in', async () => {
  const conn = connectionRow();
  world.tables.sso_connections.push(conn);
  const enforce = () => connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { enforced: true }));

  let res = await enforce();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error_code, 'enforce_needs_verified_domain');

  world.tables.sso_domains.push(domainRow(conn, { verified_at: '2026-10-19T11:00:00Z' }));
  res = await enforce();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error_code, 'enforce_needs_test_sign_in');
  assert.equal(world.tables.sso_connections[0].enforced, false);

  world.testSeen = true;
  res = await enforce();
  assert.equal(res.status, 200);
  assert.equal(world.tables.sso_connections[0].enforced, true);
  assert.deepEqual(world.tables.sso_audit_events.map((e) => e.action), ['connection.enforced']);
});

test('disable lifts enforcement and audits both; default role change is audited', async () => {
  world.tables.sso_connections.push(connectionRow({ enforced: true }));
  const off = await connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { enabled: false }));
  assert.equal(off.status, 200);
  assert.equal(world.tables.sso_connections[0].status, 'disabled');
  assert.equal(world.tables.sso_connections[0].enforced, false);

  const role = await connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { defaultRole: 'viewer' }));
  assert.equal(role.status, 200);
  assert.equal(world.tables.sso_connections[0].default_role, 'viewer');

  const bad = await connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { defaultRole: 'admin' }));
  assert.equal(bad.status, 400, 'SSO never hands out admin');

  assert.deepEqual(world.tables.sso_audit_events.map((e) => e.action), [
    'connection.enforcement_removed',
    'connection.disabled',
    'connection.default_role_changed',
  ]);
});

test('PATCH takes exactly one change', async () => {
  world.tables.sso_connections.push(connectionRow());
  const res = await connectionRoute.PATCH(json('PATCH', `${BASE}/connection`, { enforced: true, defaultRole: 'viewer' }));
  assert.equal(res.status, 400);
});

test('DELETE domain removes it and audits', async () => {
  const conn = connectionRow();
  const d = domainRow(conn, { verified_at: '2026-10-19T11:00:00Z' });
  world.tables.sso_connections.push(conn);
  world.tables.sso_domains.push(d);
  const res = await domainRoute.DELETE(json('DELETE', `${BASE}/domains/${d.id}`), idParams(String(d.id)));
  assert.equal(res.status, 200);
  assert.deepEqual(world.tables.sso_domains, []);
  assert.deepEqual(world.tables.sso_audit_events.map((e) => [e.action, (e.details as Row).domain]), [
    ['domain.removed', 'company-sso.example'],
  ]);
});
