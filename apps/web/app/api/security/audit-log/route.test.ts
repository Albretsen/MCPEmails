// ---------------------------------------------------------------------------
// GET /api/security/audit-log: tool calls and team changes, JSON and CSV.
//
//   member        calls through the USER client (RLS hides other people's
//                 private inboxes); team changes and CSV are 403
//   owner, admin  calls and team changes through the service role, CSV export
//   everyone      each entry names the person who acted
//
// Only I/O is stubbed: two fake Supabase clients over in-memory tables, which
// record which client read what, and apply eq / in / gte / lt / order / range.
//
// Run: npm run test:audit-log
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000a2';
const GONE = '00000000-0000-4000-8000-0000000000a9';

type Row = Record<string, unknown>;
interface Read {
  client: 'user' | 'service';
  table: string;
  filters: Array<[string, string, unknown]>;
}

let me: { id: string } | null = { id: OWNER };
let role: string | null = 'owner';
let workspaceId: string | null = WS;
let tables: Record<string, Row[]> = {};
/** What RLS lets the user client see in activity_log. */
let userVisibleCalls: (row: Row) => boolean = () => true;
let reads: Read[] = [];
/** A table whose every read answers an error. */
let failingTable: string | null = null;

/**
 * The two PostgREST `or` filters the audit log sends: the member scope
 * (`inbox_id.not.is.null,user_id.eq.U`) and the export keyset
 * (`created_at.lt."T",and(created_at.eq."T",id.lt.I)`).
 */
function orMatches(r: Row, expr: string): boolean {
  const member = /^inbox_id\.not\.is\.null,user_id\.eq\.(.+)$/.exec(expr);
  if (member) return (r.inbox_id ?? null) !== null || r.user_id === member[1];
  const keyset = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.(.+)\)$/.exec(expr);
  if (keyset) {
    const t = String(r.created_at);
    return t < keyset[1] || (t === keyset[2] && String(r.id) < keyset[3]);
  }
  throw new Error(`unexpected or filter: ${expr}`);
}

function fakeClient(kind: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: me }, error: me ? null : { message: 'no' } }) },
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let head = false;
      let range: [number, number] | null = null;
      const orders: Array<[string, boolean]> = [];
      const run = () => {
        reads.push({ client: kind, table, filters: [...filters] });
        if (table === failingTable) return { data: null, count: null, error: { message: 'boom' } };
        let rows = [...(tables[table] ?? [])];
        if (kind === 'user' && table === 'activity_log') rows = rows.filter(userVisibleCalls);
        for (const [op, col, v] of filters) {
          rows = rows.filter((r) => {
            const x = r[col];
            if (op === 'eq') return x === v;
            if (op === 'in') return (v as unknown[]).includes(x);
            if (op === 'gte') return String(x) >= String(v);
            if (op === 'lt') return String(x) < String(v);
            if (op === 'or') return orMatches(r, String(v));
            return true;
          });
        }
        for (const [col, asc] of [...orders].reverse()) {
          rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        const count = rows.length;
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (table === 'activity_log') {
          rows = rows.map((r) => ({
            ...r,
            inboxes: r.inbox_email ? { email_address: r.inbox_email, display_name: null } : null,
            api_keys: r.key_name ? { name: r.key_name, key_prefix: 'abcd1234' } : null,
          }));
        }
        return { data: head ? null : rows, count, error: null };
      };
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (_cols: string, opts?: { head?: boolean }) => { head = opts?.head === true; return b; },
        eq: (c: string, v: unknown) => { filters.push(['eq', c, v]); return b; },
        in: (c: string, v: unknown) => { filters.push(['in', c, v]); return b; },
        gte: (c: string, v: unknown) => { filters.push(['gte', c, v]); return b; },
        lt: (c: string, v: unknown) => { filters.push(['lt', c, v]); return b; },
        order: (c: string, o: { ascending: boolean }) => { orders.push([c, o.ascending]); return b; },
        range: (from: number, to: number) => { range = [from, to]; return b; },
        limit: (n: number) => { range = [0, n - 1]; return b; },
        or: (expr: string) => { filters.push(['or', 'or', expr]); return b; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      });
      return b;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fakeClient('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fakeClient('service') } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => workspaceId } });
nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => role,
    canManageWorkspace: (r: string | null) => r === 'owner' || r === 'admin',
  },
});

const route = await import('./route.ts');
const lib = await import('../../../../src/lib/security/audit-log.ts');
const { NextRequest } = await import('next/server');

function call(i: number, extra: Row = {}): Row {
  const t = new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + i * 1000).toISOString();
  return {
    id: `call-${String(i).padStart(5, '0')}`,
    workspace_id: WS,
    inbox_id: 'inbox-team',
    tool_name: 'email_send',
    status: 'success',
    error_code: null,
    duration_ms: 12,
    created_at: t,
    user_id: OWNER,
    inbox_email: 'team@example.test',
    key_name: 'Claude',
    ...extra,
  };
}

function reset(opts: { role?: string | null } = {}) {
  me = { id: opts.role === 'member' ? MEMBER : OWNER };
  role = opts.role === undefined ? 'owner' : opts.role;
  workspaceId = WS;
  reads = [];
  failingTable = null;
  userVisibleCalls = () => true;
  tables = {
    activity_log: [
      call(1),
      call(2, { user_id: MEMBER, inbox_email: 'private@example.test' }),
      call(3, { user_id: GONE }),
      call(4, { workspace_id: 'other-ws' }),
    ],
    users: [
      { id: OWNER, email: 'owner@example.test', display_name: 'Olivia Owner' },
      { id: MEMBER, email: 'member@example.test', display_name: null },
    ],
    workspace_audit_events: [
      { id: 'ev-1', workspace_id: WS, kind: 'role_changed', actor_user_id: OWNER, target: MEMBER, details: { from: 'member', to: 'admin' }, created_at: '2026-11-02T10:00:00.000Z' },
      { id: 'ev-2', workspace_id: WS, kind: 'invite_sent', actor_user_id: OWNER, target: 'new@example.test', details: { role: 'member' }, created_at: '2026-11-03T10:00:00.000Z' },
      { id: 'ev-3', workspace_id: 'other-ws', kind: 'invite_sent', actor_user_id: OWNER, target: 'x@example.test', details: {}, created_at: '2026-11-03T10:00:00.000Z' },
    ],
  };
}

const get = (qs = '') => route.GET(new NextRequest(new URL(`/api/security/audit-log${qs}`, 'https://mcpemails.com')));

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

test('GET is the only exported method (any other is 405 from Next.js)', () => {
  const mod = route as Record<string, unknown>;
  assert.equal(typeof mod.GET, 'function');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(mod[method], undefined, method);
});

test('401 without a session, 403 without a workspace or membership', async () => {
  reset();
  me = null;
  assert.equal((await get()).status, 401);
  reset();
  workspaceId = null;
  assert.equal((await get()).status, 403);
  reset({ role: null });
  assert.equal((await get()).status, 403);
});

test('400 on an unknown source, format or date', async () => {
  reset();
  assert.equal((await get('?source=mail')).status, 400);
  assert.equal((await get('?format=xml')).status, 400);
  assert.equal((await get('?since=yesterday-ish')).status, 400);
  assert.equal((await get('?until=nope')).status, 400);
});

test('owner: every call in the workspace through the service role, with the person who acted', async () => {
  reset();
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 3);
  assert.deepEqual(body.entries.map((e: Row) => e.id), ['call-00003', 'call-00002', 'call-00001']);
  const byId = Object.fromEntries(body.entries.map((e: Row) => [e.id, e]));
  assert.deepEqual(byId['call-00001'].person, { id: OWNER, email: 'owner@example.test', name: 'Olivia Owner' });
  assert.deepEqual(byId['call-00002'].person, { id: MEMBER, email: 'member@example.test', name: null });
  // An account that is gone: the id, no email or name (the UI says "former member").
  assert.deepEqual(byId['call-00003'].person, { id: GONE, email: null, name: null });
  assert.ok(reads.filter((r) => r.table === 'activity_log').every((r) => r.client === 'service'));
  assert.ok(reads.filter((r) => r.table === 'activity_log').every((r) => r.filters.some(([op, c, v]) => op === 'eq' && c === 'workspace_id' && v === WS)));
});

test('member: calls through the user client, so RLS decides which inboxes show', async () => {
  reset({ role: 'member' });
  userVisibleCalls = (r) => r.inbox_email !== 'private@example.test';
  const body = await (await get()).json();
  assert.deepEqual(body.entries.map((e: Row) => e.id), ['call-00003', 'call-00001']);
  assert.equal(body.total, 2);
  assert.ok(reads.filter((r) => r.table === 'activity_log').every((r) => r.client === 'user'));
});

test('member: a call that named no inbox shows only when the member made it', async () => {
  reset({ role: 'member' });
  tables.activity_log.push(
    call(6, { inbox_id: null, inbox_email: null, user_id: MEMBER }),
    call(7, { inbox_id: null, inbox_email: null, user_id: OWNER }),
  );
  const body = await (await get()).json();
  const ids = body.entries.map((e: Row) => e.id);
  assert.ok(ids.includes('call-00006'), 'their own cross-inbox call');
  assert.ok(!ids.includes('call-00007'), "never someone else's");
  assert.ok(reads.filter((r) => r.table === 'activity_log').every((r) =>
    r.filters.some(([op, , v]) => op === 'or' && v === `inbox_id.not.is.null,user_id.eq.${MEMBER}`)));
  // Owner and admin see every row, metadata only.
  reset();
  tables.activity_log.push(call(7, { inbox_id: null, inbox_email: null, user_id: MEMBER }));
  assert.ok((await (await get()).json()).entries.some((e: Row) => e.id === 'call-00007'));
});

test('CSV: until is pinned to the start of the export, and pages follow a keyset, so rows written meanwhile never shift it', async () => {
  reset();
  tables.activity_log = Array.from({ length: 5 }, (_, i) => call(i));
  const start = new Date(Date.UTC(2026, 10, 1, 0, 0, 3)); // after call 0..2, before 3 and 4
  const stream = lib.auditCsvStream(fakeClient('service'), WS, 'calls', { since: null, until: null }, 1000, start);
  const reader = stream.getReader();
  const chunks: string[] = [];
  const dec = new TextDecoder();
  // Header, then the first page; a row is written newest-first meanwhile.
  chunks.push(dec.decode((await reader.read()).value));
  tables.activity_log.push(call(-1, { id: 'call-late', created_at: '2026-11-01T00:00:02.500Z' }));
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(dec.decode(value));
  }
  const lines = chunks.join('').split('\r\n').filter(Boolean).slice(1);
  const ids = lines.map((l) => l.split(',')[0]);
  assert.equal(new Set(ids).size, ids.length, 'no row twice');
  assert.ok(reads.some((r) => r.filters.some(([op, c, v]) => op === 'lt' && c === 'created_at' && v === start.toISOString())));
  assert.equal(lines.some((l) => l.startsWith('2026-11-01T00:00:03')), false, 'nothing from after the start');
});

test('member: team changes and the CSV export are owner/admin only', async () => {
  reset({ role: 'member' });
  assert.equal((await get('?source=events')).status, 403);
  assert.equal((await get('?format=csv')).status, 403);
  assert.equal((await get('?format=csv&source=events')).status, 403);
  reset({ role: 'viewer' });
  assert.equal((await get('?format=csv')).status, 403);
  assert.equal(reads.filter((r) => r.table === 'workspace_audit_events').length, 0);
});

test('admin: team changes, newest first, with actor and target person', async () => {
  reset({ role: 'admin' });
  const res = await get('?source=events');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.deepEqual(body.events.map((e: Row) => e.id), ['ev-2', 'ev-1']);
  const roleChange = body.events[1];
  assert.equal(roleChange.kind, 'role_changed');
  assert.equal(roleChange.actor.email, 'owner@example.test');
  assert.equal(roleChange.targetPerson.email, 'member@example.test');
  assert.deepEqual(roleChange.details, { from: 'member', to: 'admin' });
  assert.equal(body.events[0].targetPerson, null);
  assert.equal(body.events[0].target, 'new@example.test');
});

test('since and until reach the query as created_at bounds, on JSON and CSV alike', async () => {
  reset();
  const body = await (await get('?since=2026-11-01T00:00:02Z&until=2026-11-01T00:00:03Z')).json();
  assert.deepEqual(body.entries.map((e: Row) => e.id), ['call-00002']);
  reset();
  const csv = await (await get('?format=csv&since=2026-11-01T00:00:02Z&until=2026-11-01T00:00:03Z')).text();
  assert.equal(csv.trim().split('\r\n').length, 2);
  assert.ok(reads.some((r) => r.filters.some(([op, c]) => op === 'gte' && c === 'created_at')));
  assert.ok(reads.some((r) => r.filters.some(([op, c]) => op === 'lt' && c === 'created_at')));
});

test('CSV: an attachment, the header, one line per call, formula injection neutralised', async () => {
  reset();
  tables.activity_log.push(call(5, { tool_name: '=HYPERLINK("http://x")', inbox_email: '+1@example.test', key_name: '@sum, "quoted"' }));
  const res = await get('?format=csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="mcpemails-audit-tool-calls-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const lines = (await res.text()).split('\r\n').filter(Boolean);
  assert.equal(lines[0], lib.CALLS_CSV_HEADER.join(','));
  assert.equal(lines.length, 1 + 4);
  // Newest first: the injected row.
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://x"")"`), lines[1]);
  assert.ok(lines[1].includes(`'+1@example.test`), lines[1]);
  assert.ok(lines[1].includes(`"'@sum, ""quoted"""`), lines[1]);
  assert.ok(lines.some((l) => l.includes('owner@example.test') && l.includes('Olivia Owner')));
  assert.ok(lines.every((l) => !l.includes('other-ws')));
});

test('CSV of team changes: actor and target email', async () => {
  reset();
  const res = await get('?format=csv&source=events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /team-changes/);
  const lines = (await res.text()).split('\r\n').filter(Boolean);
  assert.equal(lines[0], lib.EVENTS_CSV_HEADER.join(','));
  assert.equal(lines.length, 3);
  assert.ok(lines[2].startsWith('2026-11-02T10:00:00.000Z,owner@example.test,Olivia Owner,role_changed,'));
  assert.ok(lines[2].includes('member@example.test'));
});

test('CSV pages past the 1000-row PostgREST cap in a total order', async () => {
  reset();
  tables.activity_log = Array.from({ length: 2500 }, (_, i) => call(i));
  const res = await get('?format=csv');
  const lines = (await res.text()).split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2501);
  const pages = reads.filter((r) => r.table === 'activity_log');
  assert.equal(pages.length, 3);
  // No row twice, none lost.
  const ids = new Set(lines.slice(1).map((l) => l.split(',')[0]));
  assert.equal(ids.size, 2500);
});

test('the export stops at its row ceiling and says so', async () => {
  reset();
  tables.activity_log = Array.from({ length: 10 }, (_, i) => call(i));
  const stream = lib.auditCsvStream(fakeClient('service'), WS, 'calls', { since: null, until: null }, 3);
  const text = await new Response(stream).text();
  const lines = text.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 1 + 3 + 1);
  assert.match(lines[4], /^# stopped at 3 rows/);
});

test('a page that fails mid-export ends the file with a marker, never silently short', async () => {
  reset();
  failingTable = 'activity_log';
  const text = await quiet(() => new Response(lib.auditCsvStream(fakeClient('service'), WS, 'calls', { since: null, until: null })).text());
  assert.match(text, /# export incomplete/);
});

test('csvCell: formula prefixes, quoting, null', () => {
  assert.equal(lib.csvCell('=1+1'), `'=1+1`);
  assert.equal(lib.csvCell('-2'), `'-2`);
  assert.equal(lib.csvCell('\tx'), `'\tx`);
  assert.equal(lib.csvCell('a,b'), '"a,b"');
  assert.equal(lib.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(lib.csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(lib.csvCell(null), '');
  assert.equal(lib.csvCell(42), '42');
  assert.equal(lib.csvCell({ to: ['a.com'] }), '"{""to"":[""a.com""]}"');
});

test('a failed read is a 500, never a partial page', async () => {
  reset();
  failingTable = 'activity_log';
  assert.equal((await quiet(() => get())).status, 500);
  reset({ role: 'admin' });
  failingTable = 'workspace_audit_events';
  assert.equal((await quiet(() => get('?source=events'))).status, 500);
});

test('a retired mailbox row shows its plain address', () => {
  assert.equal(
    lib.displayInboxAddress('a@b.example#retired-00000000-0000-4000-8000-000000000001'),
    'a@b.example',
  );
  assert.equal(lib.displayInboxAddress('a@b.example'), 'a@b.example');
  assert.equal(lib.displayInboxAddress(null), null);
});
