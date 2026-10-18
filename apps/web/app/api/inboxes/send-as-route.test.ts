// ---------------------------------------------------------------------------
// /api/inboxes/[id]/send-as: who may do what, and which client touches what.
//
// The rules (verification, limits) are covered by src/lib/inboxes/send-as.test.ts.
// This pins the route around them:
//   - signed out is 401, an inbox the caller cannot see is 404, before any
//     alias row is read;
//   - a viewer may list but every write is 403 insufficient_role, with no
//     mail sent and no row written;
//   - the user-scoped client never touches inbox_sender_aliases (it has no
//     write grant and cannot read code_hash); the service-role client does,
//     scoped to the inbox id AND its workspace;
//   - every exported method is exercised, and PUT/PATCH are not exported.
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
  filters: Array<[string, string, unknown]>;
  payload: unknown;
}

interface World {
  signedIn: boolean;
  visible: boolean;
  role: string | null;
  provider: string;
  aliases: Array<Record<string, unknown>>;
  calls: Call[];
  mails: Array<{ to: string; code: string }>;
}

let world: World;

function reset(overrides: Partial<World> = {}): void {
  world = { signedIn: true, visible: true, role: 'member', provider: 'imap', aliases: [], calls: [], mails: [], ...overrides };
}

function matches(row: Record<string, unknown>, filters: Call['filters']): boolean {
  return filters.every(([f, col, val]) => (f === 'eq' ? row[col] === val : true));
}

function resolve(call: Call): { data: unknown; error: unknown } {
  if (call.table === 'workspace_members') {
    return { data: world.role ? { role: world.role } : null, error: null };
  }
  if (call.table === 'inboxes' && call.client === 'user') {
    if (!world.visible) return { data: null, error: { message: 'no rows' } };
    return {
      data: { id: INBOX, workspace_id: WS, provider: world.provider, email_address: 'primary@icloud.example', smtp_host: 'smtp.mail.me.com' },
      error: null,
    };
  }
  if (call.table === 'inboxes' && call.client === 'service') return { data: [], error: null };
  if (call.table === 'inbox_sender_aliases') {
    if (call.client === 'user') return { data: null, error: { code: '42501', message: 'permission denied' } };
    if (call.op === 'insert') {
      const row = {
        id: `al-${world.aliases.length + 1}`,
        verified_at: null,
        code_hash: null,
        code_expires_at: null,
        code_attempts: 0,
        code_sent_at: null,
        created_at: '2026-10-18T12:00:00Z',
        ...(call.payload as Record<string, unknown>),
      };
      world.aliases.push(row);
      return { data: row, error: null };
    }
    const hit = world.aliases.filter((r) => matches(r, call.filters));
    if (call.op === 'update') {
      for (const r of hit) Object.assign(r, call.payload as Record<string, unknown>);
      return { data: null, error: null };
    }
    if (call.op === 'delete') {
      world.aliases = world.aliases.filter((r) => !hit.includes(r));
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    return { data: call.filters.some(([, c]) => c === 'id') ? hit[0] ?? null : hit, error: null };
  }
  return { data: null, error: null };
}

function client(kind: 'user' | 'service') {
  return {
    from(table: string) {
      const call: Call = { client: kind, table, op: 'select', filters: [], payload: null };
      const run = () => {
        world.calls.push(call);
        return resolve(call);
      };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      for (const op of ['update', 'insert', 'delete'] as const) {
        builder[op] = (payload?: unknown) => {
          call.op = op;
          call.payload = payload ?? null;
          return builder;
        };
      }
      for (const f of ['eq', 'is', 'in', 'ilike', 'order', 'limit', 'not']) {
        builder[f] = (col: string, val: unknown) => {
          call.filters.push([f, col, val]);
          return builder;
        };
      }
      builder.single = async () => run();
      builder.maybeSingle = async () => run();
      builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(ok, ko);
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
nodeMock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => false } });
nodeMock.module('@/lib/email/send-as-code', {
  namedExports: {
    sendSendAsCode: async (p: { to: string; code: string }) => {
      world.mails.push({ to: p.to, code: p.code });
    },
  },
});

const route = await import('./[id]/send-as/route.ts');
const params = { params: Promise.resolve({ id: INBOX }) };
const URL_BASE = `https://mcpemails.test/api/inboxes/${INBOX}/send-as`;

const get = () => route.GET(new Request(URL_BASE) as never, params);
const post = (body: unknown) =>
  route.POST(new Request(URL_BASE, { method: 'POST', body: JSON.stringify(body) }) as never, params);
const del = (aliasId: string) =>
  route.DELETE(new Request(`${URL_BASE}?alias_id=${aliasId}`, { method: 'DELETE' }) as never, params);

const aliasCalls = (kind: 'user' | 'service') =>
  world.calls.filter((c) => c.client === kind && c.table === 'inbox_sender_aliases');

function assertScoped(): void {
  assert.equal(aliasCalls('user').length, 0, 'the user client never touches inbox_sender_aliases');
  for (const c of aliasCalls('service')) {
    if (c.op === 'insert') {
      assert.equal((c.payload as Record<string, unknown>).inbox_id, INBOX);
      continue;
    }
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'inbox_id' && v === INBOX), `${c.op} scoped to the inbox`);
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'workspace_id' && v === WS), `${c.op} scoped to its workspace`);
  }
}

beforeEach(() => reset());

test('only GET, POST and DELETE are exported', () => {
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).sort(), ['DELETE', 'GET', 'POST']);
});

test('signed out: 401 on every method, nothing read', async () => {
  reset({ signedIn: false });
  assert.equal((await get()).status, 401);
  assert.equal((await post({ action: 'add', email_address: 'a@b.example' })).status, 401);
  assert.equal((await del('al-1')).status, 401);
  assert.equal(aliasCalls('service').length, 0);
});

test('an inbox the caller cannot see is 404 on every method', async () => {
  reset({ visible: false });
  assert.equal((await get()).status, 404);
  assert.equal((await post({ action: 'add', email_address: 'a@b.example' })).status, 404);
  assert.equal((await del('al-1')).status, 404);
  assert.equal(aliasCalls('service').length, 0);
});

test('a malformed body is 400 before any lookup', async () => {
  for (const body of [null, [], { action: 'nope' }, { action: 'verify' }, { action: 'resend', alias_id: 7 }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const res = await route.DELETE(new Request(URL_BASE, { method: 'DELETE' }) as never, params);
  assert.equal(res.status, 400, 'DELETE without alias_id');
  assert.equal(world.calls.length, 0);
});

test('member: add mails the code, verify with it, list, remove', async () => {
  const added = await post({ action: 'add', email_address: 'CrackerJack@iCloud.example' });
  assert.equal(added.status, 200);
  const { alias } = await added.json();
  assert.equal(alias.email_address, 'crackerjack@icloud.example');
  assert.equal(alias.verified, false);
  assert.equal(world.mails.length, 1);
  assert.equal(world.mails[0].to, 'crackerjack@icloud.example');

  const wrong = await post({ action: 'verify', alias_id: alias.id, code: world.mails[0].code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'wrong_code');

  const ok = await post({ action: 'verify', alias_id: alias.id, code: world.mails[0].code });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).alias.verified, true);

  const listed = await (await get()).json();
  assert.deepEqual(listed.aliases.map((a: { email_address: string; verified: boolean }) => [a.email_address, a.verified]), [
    ['crackerjack@icloud.example', true],
  ]);
  assert.equal(JSON.stringify(listed).includes('code_hash'), false, 'the hash never leaves the server');

  assert.equal((await del(alias.id)).status, 200);
  assert.equal(world.aliases.length, 0);
  assert.equal((await del(alias.id)).status, 404, 'a second delete finds nothing');
  assertScoped();
});

test('viewer: may list, every write is 403 and nothing is mailed or written', async () => {
  reset({ role: 'viewer', aliases: [{ id: 'al-1', inbox_id: INBOX, workspace_id: WS, email_address: 'a@icloud.example', display_name: null, verified_at: null, code_hash: 'h', code_expires_at: null, code_attempts: 0, code_sent_at: null, created_at: 'x' }] });
  assert.equal((await get()).status, 200);
  for (const body of [
    { action: 'add', email_address: 'b@icloud.example' },
    { action: 'resend', alias_id: 'al-1' },
    { action: 'verify', alias_id: 'al-1', code: '123456' },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 403, body.action);
    assert.equal((await res.json()).error_code, 'insufficient_role');
  }
  assert.equal((await del('al-1')).status, 403);
  assert.equal(world.mails.length, 0);
  assert.equal(aliasCalls('service').filter((c) => c.op !== 'select').length, 0);
});

test('a non-member is refused like a viewer', async () => {
  reset({ role: null });
  assert.equal((await post({ action: 'add', email_address: 'b@icloud.example' })).status, 403);
  assert.equal(world.mails.length, 0);
});

test('Gmail and Outlook inboxes are refused: their Send As comes from the provider', async () => {
  for (const provider of ['gmail', 'outlook']) {
    reset({ provider });
    const res = await post({ action: 'add', email_address: 'b@icloud.example' });
    assert.equal(res.status, 400, provider);
    assert.equal((await res.json()).error, 'unsupported_provider');
  }
  assert.equal(world.mails.length, 0);
});
