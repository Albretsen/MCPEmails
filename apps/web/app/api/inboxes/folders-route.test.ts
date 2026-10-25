// ---------------------------------------------------------------------------
// /api/inboxes/[id]/folders: who may do what, and which client touches what.
//
// The rules are covered by src/lib/inboxes/folder-overrides.test.ts and the
// edge function's folder-overrides.test.ts. This pins the route around them:
//   - signed out is 401, an inbox the caller cannot see is 404, a viewer is
//     403 insufficient_role, all before the mail server is dialled or the
//     column is read;
//   - the user-scoped client only reads (id, workspace_id); every read of the
//     credentials and of folder_overrides, and the one write, go through the
//     service-role client scoped to the inbox id AND its workspace;
//   - Gmail/Outlook and STARTTLS inboxes are refused as unsupported_inbox;
//   - a pick is only stored after a live listing, INBOX and duplicates are
//     refused, and clearing needs no listing;
//   - a missing column is 503 'unavailable';
//   - GET and PUT are the only exported methods (others are 405 from Next).
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
  visible: boolean;
  role: string | null;
  row: Record<string, unknown>;
  overrides: unknown;
  columnMissing: boolean;
  listFails: boolean;
  lists: number;
  calls: Call[];
}

let world: World;

const IMAP_ROW = {
  id: INBOX,
  workspace_id: WS,
  provider: 'imap',
  email_address: 'owner@ovh.example',
  imap_host: 'ssl0.ovh.example',
  imap_port: 993,
  imap_security: 'tls',
  imap_username: null,
  imap_password: 'ciphertext',
  oauth_access_token: null,
};

const OVH = [
  { name: 'INBOX', delimiter: '.', flags: [] },
  { name: 'INBOX.Éléments envoyés', delimiter: '.', flags: [] },
  { name: 'INBOX.INBOX.Sent', delimiter: '.', flags: [] },
  { name: 'INBOX.Brouillons', delimiter: '.', flags: [] },
  { name: 'INBOX.Corbeille', delimiter: '.', flags: [] },
];

function reset(overrides: Partial<World> = {}): void {
  world = {
    signedIn: true,
    visible: true,
    role: 'member',
    row: { ...IMAP_ROW },
    overrides: null,
    columnMissing: false,
    listFails: false,
    lists: 0,
    calls: [],
    ...overrides,
  };
}

function resolve(call: Call): { data: unknown; error: unknown } {
  if (call.table === 'workspace_members') return { data: world.role ? { role: world.role } : null, error: null };
  if (call.table !== 'inboxes') return { data: null, error: null };
  if (call.client === 'user') {
    if (call.columns !== 'id, workspace_id') return { data: null, error: { code: '42501', message: 'permission denied' } };
    return world.visible ? { data: { id: INBOX, workspace_id: WS }, error: null } : { data: null, error: { message: 'no rows' } };
  }
  if (call.op === 'update') {
    if (world.columnMissing) return { data: null, error: { code: '42703', message: 'column does not exist' } };
    world.overrides = (call.payload as { folder_overrides: unknown }).folder_overrides;
    return { data: null, error: null };
  }
  if (call.columns === 'folder_overrides') {
    if (world.columnMissing) return { data: null, error: { code: '42703', message: 'column does not exist' } };
    return { data: { folder_overrides: world.overrides }, error: null };
  }
  return { data: world.row, error: null };
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
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});
nodeMock.module('@/lib/inboxes/folder-overrides-imap', {
  namedExports: {
    listInboxMailboxes: async (row: { imap_host: string; imap_password: string }) => {
      world.lists += 1;
      assert.equal(row.imap_host, 'ssl0.ovh.example');
      assert.equal(row.imap_password, 'ciphertext');
      if (world.listFails) throw new Error('ETIMEDOUT');
      return OVH;
    },
  },
});

const route = await import('./[id]/folders/route.ts');
const params = { params: Promise.resolve({ id: INBOX }) };
const URL_BASE = `https://mcpemails.test/api/inboxes/${INBOX}/folders`;

const get = () => route.GET(new Request(URL_BASE) as never, params);
const put = (body: unknown) =>
  route.PUT(new Request(URL_BASE, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never, params);

function assertScoped(): void {
  for (const c of world.calls.filter((c) => c.client === 'user' && c.table === 'inboxes')) {
    assert.equal(c.columns, 'id, workspace_id', 'the user client never reads credentials or folder_overrides');
    assert.equal(c.op, 'select');
  }
  for (const c of world.calls.filter((c) => c.client === 'service' && c.table === 'inboxes')) {
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'id' && v === INBOX), `${c.op} scoped to the inbox`);
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'workspace_id' && v === WS), `${c.op} scoped to its workspace`);
  }
}

const serviceWrites = () => world.calls.filter((c) => c.client === 'service' && c.op === 'update');

beforeEach(() => reset());

test('only GET and PUT are exported', () => {
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort(), ['GET', 'PUT']);
});

test('signed out: 401 on every method, nothing dialled or read', async () => {
  reset({ signedIn: false });
  assert.equal((await get()).status, 401);
  assert.equal((await put({ role: 'sent', folder: 'INBOX.Éléments envoyés' })).status, 401);
  assert.equal(world.lists, 0);
  assert.equal(world.calls.filter((c) => c.client === 'service').length, 0);
});

test('an inbox the caller cannot see is 404 on every method', async () => {
  reset({ visible: false });
  assert.equal((await get()).status, 404);
  assert.equal((await put({ role: 'sent', folder: null })).status, 404);
  assert.equal(world.lists, 0);
  assert.equal(world.calls.filter((c) => c.client === 'service').length, 0);
});

test('a viewer and a non-member are 403 insufficient_role on every method', async () => {
  for (const role of ['viewer', null]) {
    reset({ role });
    for (const res of [await get(), await put({ role: 'sent', folder: null })]) {
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error_code, 'insufficient_role');
    }
  }
  assert.equal(world.lists, 0);
  assert.equal(serviceWrites().length, 0);
});

test('a malformed PUT is 400 before any lookup', async () => {
  for (const body of ['not json', null, [], { role: 'inbox', folder: 'X' }, { role: 'sent' }, { role: 'sent', folder: 7 }, { folder: 'X' }]) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(world.calls.length, 0);
});

test('Gmail, Outlook and STARTTLS inboxes are unsupported', async () => {
  for (const row of [
    { ...IMAP_ROW, provider: 'gmail', imap_host: null, imap_password: null, oauth_access_token: 'ct' },
    { ...IMAP_ROW, provider: 'outlook', imap_host: null, imap_password: null, oauth_access_token: 'ct' },
    { ...IMAP_ROW, imap_security: 'starttls' },
  ]) {
    reset({ row });
    for (const res of [await get(), await put({ role: 'sent', folder: null })]) {
      assert.equal(res.status, 400, String(row.provider));
      assert.equal((await res.json()).error, 'unsupported_inbox');
    }
  }
  assert.equal(world.lists, 0);
});

test('member: GET lists folders and the automatic pick per role', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.folders, ['INBOX.Éléments envoyés', 'INBOX.INBOX.Sent', 'INBOX.Brouillons', 'INBOX.Corbeille']);
  assert.deepEqual(body.roles.map((r: { role: string }) => r.role), ['sent', 'drafts', 'trash', 'spam', 'archive']);
  assert.equal(body.roles[1].automatic, 'INBOX.Brouillons');
  assert.equal(JSON.stringify(body).includes('ciphertext'), false, 'the password never leaves the server');
  assertScoped();
});

test('member: PUT saves a listed folder, then clears it without dialling', async () => {
  const saved = await put({ role: 'sent', folder: 'INBOX.Éléments envoyés' });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { overrides: { sent: 'INBOX.Éléments envoyés' } });
  assert.deepEqual(world.overrides, { sent: 'INBOX.Éléments envoyés' });
  assert.equal(world.lists, 1);

  const listed = await (await get()).json();
  assert.equal(listed.roles[0].override, 'INBOX.Éléments envoyés');

  const lists = world.lists;
  const cleared = await put({ role: 'sent', folder: null });
  assert.equal(cleared.status, 200);
  assert.equal(world.overrides, null);
  assert.equal(world.lists, lists, 'reset needs no listing');
  assertScoped();
});

test('member: INBOX, an unlisted name and a folder used by another role are refused, nothing written', async () => {
  reset({ overrides: { drafts: 'INBOX.Brouillons' } });
  const cases: Array<[unknown, number, string]> = [
    [{ role: 'trash', folder: 'INBOX' }, 400, 'inbox_not_allowed'],
    [{ role: 'sent', folder: 'INBOX.Sent' }, 400, 'not_listed'],
    [{ role: 'trash', folder: 'INBOX.Brouillons' }, 409, 'used_by_other_role'],
  ];
  for (const [body, status, error] of cases) {
    const res = await put(body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal((await res.json()).error, error);
  }
  assert.equal(serviceWrites().length, 0);
});

test('an unreachable mail server is one 502 on GET and on a pick', async () => {
  reset({ listFails: true });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'folders_unreachable');
  assert.equal((await put({ role: 'sent', folder: 'INBOX.Éléments envoyés' })).status, 502);
  assert.equal(serviceWrites().length, 0);
});

test('before the migration: 503 unavailable, and nothing else is touched', async () => {
  reset({ columnMissing: true });
  for (const res of [await get(), await put({ role: 'sent', folder: null })]) {
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'unavailable');
  }
  assert.equal(world.lists, 0);
});
