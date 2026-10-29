// ---------------------------------------------------------------------------
// PATCH /api/inboxes/[id]/connection: change a generic IMAP/SMTP inbox's
// connection type on the inbox itself, without re-entering the password.
//
// Pins:
//   - signed out 401, invisible 404, viewer 403, malformed 400: all before any
//     dial or write;
//   - Gmail and branded IMAP inboxes are unsupported_inbox;
//   - narrowing dials nothing and writes NULL host and port for the dropped
//     half, on the same row (update scoped to id AND workspace, never a new
//     row, never the password);
//   - widening dials ONLY the added half, with the stored password and login,
//     and saves the port that worked;
//   - a widening that fails answers 422 and writes nothing;
//   - a refused stored login answers needs_login; a supplied login is then
//     checked on every half the new mode keeps and replaces the stored one;
//   - the stored password only goes to an added host on the registrable domain
//     of a saved one; any other host is password_required until it is typed,
//     and security 'none' is refused, both before any dial;
//   - PATCH is the only exported method (others are 405 from Next).
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

type Mode = 'both' | 'imap' | 'smtp';

interface Dial {
  protocol: string;
  host: string;
  port: number;
  password: string;
  username: string | undefined;
}

interface Call {
  client: 'user' | 'service';
  table: string;
  op: string;
  filters: Array<[string, string, unknown]>;
  payload: Record<string, unknown> | null;
}

interface World {
  signedIn: boolean;
  visible: boolean;
  role: string;
  row: Record<string, unknown>;
  dials: Dial[];
  /** Per protocol: what the server answers. */
  answer: Record<string, 'ok' | 'auth' | 'timeout'>;
  /** Password the servers accept on 'auth' answers (a supplied one). */
  acceptedPassword: string | null;
  calls: Call[];
}

let world: World;

function storedRow(mode: Mode): Record<string, unknown> {
  return {
    id: INBOX,
    workspace_id: WS,
    provider: 'imap',
    service: 'generic',
    email_address: 'box@example.test',
    imap_host: mode === 'smtp' ? null : 'imap.example.test',
    imap_port: mode === 'smtp' ? null : 993,
    imap_security: 'tls',
    imap_username: 'box-login',
    imap_password: 'enc:stored-secret',
    smtp_host: mode === 'imap' ? null : 'smtp.example.test',
    smtp_port: mode === 'imap' ? null : 465,
    smtp_security: 'tls',
  };
}

function reset(mode: Mode = 'both', overrides: Partial<World> = {}): void {
  world = {
    signedIn: true,
    visible: true,
    role: 'member',
    row: storedRow(mode),
    dials: [],
    answer: { imap: 'ok', smtp: 'ok' },
    acceptedPassword: null,
    calls: [],
    ...overrides,
  };
}

function client(kind: 'user' | 'service') {
  return {
    from(table: string) {
      const call: Call = { client: kind, table, op: 'select', filters: [], payload: null };
      const run = () => {
        world.calls.push(call);
        if (kind === 'user') {
          return world.visible ? { data: { id: INBOX, workspace_id: WS }, error: null } : { data: null, error: { message: 'no rows' } };
        }
        if (call.op === 'update') {
          world.row = { ...world.row, ...call.payload };
        }
        return { data: { ...world.row }, error: null };
      };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.update = (payload: Record<string, unknown>) => {
        call.op = 'update';
        call.payload = payload;
        return builder;
      };
      builder.insert = () => { throw new Error('never inserts'); };
      builder.upsert = () => { throw new Error('never upserts'); };
      for (const f of ['eq', 'is']) {
        builder[f] = (col: string, val: unknown) => {
          call.filters.push([f, col, val]);
          return builder;
        };
      }
      builder.single = async () => run();
      builder.maybeSingle = async () => run();
      return builder;
    },
    auth: {
      getUser: async () => (world.signedIn ? { data: { user: USER }, error: null } : { data: { user: null }, error: null }),
    },
  };
}

function validator(protocol: 'imap' | 'smtp') {
  return async (opts: { host: string; port: number; password: string; username?: string }) => {
    world.dials.push({ protocol, host: opts.host, port: opts.port, password: opts.password, username: opts.username });
    const answer = world.answer[protocol];
    if (answer === 'ok' || (answer === 'auth' && opts.password === world.acceptedPassword)) return { ok: true };
    if (answer === 'auth') return { ok: false, code: 'AUTH_FAILED', phase: 'authentication', message: 'Login refused.' };
    return { ok: false, code: 'TIMEOUT', phase: 'tcp', message: 'The server never answered.' };
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
nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => world.role,
    canManageInboxes: (role: string) => role === 'owner' || role === 'admin' || role === 'member',
    insufficientRoleBody: (error: string) => ({ error, error_code: 'insufficient_role' }),
  },
});
nodeMock.module('@/lib/crypto', {
  namedExports: {
    encryptToken: (v: string) => `enc:${v}`,
    decryptToken: (v: string) => v.replace(/^enc:/, ''),
  },
});
nodeMock.module('@/lib/email/validate-imap', { namedExports: { validateImapCredential: validator('imap') } });
nodeMock.module('@/lib/email/validate-smtp', { namedExports: { validateSmtpCredential: validator('smtp') } });
nodeMock.module('@/lib/email/mail-relay', { namedExports: { mailRelayConfigFromEnv: () => null } });
nodeMock.module('@/lib/email/relay-fallback', {
  namedExports: {
    refreshLearnedRelayHosts: async () => {},
    // One attempt on the requested transport; a working SMTP 465 "adjusts" to
    // 587 so the test can see the resolved port is the one saved.
    detectWithRelay: async (opts: {
      protocol: string;
      requested: { port: number; security: string };
      attempt: (c: { port: number; security: string }, timeoutMs: number, tunnel: undefined) => Promise<{ ok: boolean }>;
    }) => {
      const candidate = opts.protocol === 'smtp' && opts.requested.port === 2465 ? { port: 587, security: 'starttls' } : opts.requested;
      const result = await opts.attempt(candidate, 10_000, undefined);
      return { detection: { result, candidate, adjusted: candidate !== opts.requested, attempts: 1 }, route: null };
    },
  },
});
nodeMock.module('@/lib/email/host-guard', {
  namedExports: { guardMailHost: async () => ({ ok: true, address: '192.0.2.10' }) },
});
nodeMock.module('@/lib/email/imap-login-collision', {
  namedExports: { findConflictingInbox: async () => ({ conflict: false }) },
});
nodeMock.module('@/lib/email/auth-failure', {
  namedExports: { explainAuthFailure: () => ({ reason: 'wrong_password', fields: {} }) },
});
nodeMock.module('@/lib/errors/capture', { namedExports: { captureError: async () => {} } });

const route = await import('./[id]/connection/route.ts');
const params = { params: Promise.resolve({ id: INBOX }) };
const URL_BASE = `https://mcpemails.test/api/inboxes/${INBOX}/connection`;

const patch = (body: unknown) =>
  route.PATCH(
    new Request(URL_BASE, { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) }) as never,
    params,
  );

const writes = () => world.calls.filter((c) => c.client === 'service' && c.op === 'update');

function assertScopedToInbox(): void {
  for (const c of world.calls.filter((c) => c.client === 'service')) {
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'id' && v === INBOX), `${c.op} scoped to the inbox id`);
    assert.ok(c.filters.some(([f, col, v]) => f === 'eq' && col === 'workspace_id' && v === WS), `${c.op} scoped to its workspace`);
  }
  assert.equal(world.row.id, INBOX, 'the inbox keeps its id');
}

beforeEach(() => reset());

test('PATCH is the only exported method', () => {
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)), ['PATCH']);
});

test('signed out 401, invisible 404, viewer 403: nothing dialled or written', async () => {
  reset('imap', { signedIn: false });
  assert.equal((await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 465 })).status, 401);
  reset('imap', { visible: false });
  assert.equal((await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 465 })).status, 404);
  reset('imap', { role: 'viewer' });
  const res = await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 465 });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error_code, 'insufficient_role');
  assert.equal(world.dials.length, 0);
  assert.equal(writes().length, 0);
});

test('a malformed body or mode is 400 before any lookup', async () => {
  for (const body of ['not json', null, [], {}, { mode: 'receive' }, { mode: 7 }]) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(world.calls.length, 0);
});

test('Gmail and branded IMAP inboxes are unsupported', async () => {
  for (const row of [
    { ...storedRow('both'), provider: 'gmail', imap_host: null, smtp_host: null, imap_password: null },
    { ...storedRow('both'), service: 'icloud' },
  ]) {
    reset('both', { row });
    const res = await patch({ mode: 'imap' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error_code, 'unsupported_inbox');
  }
  assert.equal(writes().length, 0);
});

test('narrow both to receive only: no dial, SMTP cleared on the same row, password untouched', async () => {
  const res = await patch({ mode: 'imap' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'imap');
  assert.equal(body.smtpHost, null);
  assert.equal(JSON.stringify(body).includes('secret'), false, 'the password never leaves the server');
  assert.equal(world.dials.length, 0, 'narrowing dials nothing');
  assert.equal(writes().length, 1);
  const [write] = writes();
  assert.equal(write.payload!.smtp_host, null);
  assert.equal(write.payload!.smtp_port, null);
  assert.equal('imap_host' in write.payload!, false, 'the kept half is not rewritten');
  assert.equal('imap_password' in write.payload!, false);
  assert.equal(world.row.imap_host, 'imap.example.test');
  assertScopedToInbox();
});

test('narrow both to send only: IMAP cleared', async () => {
  const res = await patch({ mode: 'smtp' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mode, 'smtp');
  assert.equal(world.dials.length, 0);
  assert.equal(world.row.imap_host, null);
  assert.equal(world.row.imap_port, null);
  assert.equal(world.row.smtp_host, 'smtp.example.test');
  assertScopedToInbox();
});

test('widen receive only to both: dials only SMTP with the stored login, saves the port that worked', async () => {
  reset('imap');
  const res = await patch({ mode: 'both', smtpHost: 'SMTP.Example.test', smtpPort: 2465, smtpSecurity: 'tls', imapHost: 'ignored.example' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(world.dials.map((d) => d.protocol), ['smtp'], 'only the added half is dialled');
  assert.equal(world.dials[0].host, 'smtp.example.test');
  assert.equal(world.dials[0].password, 'stored-secret', 'the stored password, decrypted');
  assert.equal(world.dials[0].username, 'box-login', 'the stored login');
  const body = await res.json();
  assert.equal(body.mode, 'both');
  assert.equal(world.row.smtp_host, 'smtp.example.test');
  assert.equal(world.row.smtp_port, 587, 'the resolved port, not the requested one');
  assert.equal(world.row.smtp_security, 'starttls');
  assert.equal(world.row.imap_host, 'imap.example.test', 'IMAP untouched, the body cannot rewrite it');
  assert.equal('imap_password' in writes()[0].payload!, false);
  assertScopedToInbox();
});

test('widen send only to both: dials only IMAP', async () => {
  reset('smtp');
  const res = await patch({ mode: 'both', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls' });
  assert.equal(res.status, 200);
  assert.deepEqual(world.dials.map((d) => d.protocol), ['imap']);
  assert.equal(world.row.imap_host, 'imap.example.test');
  assert.equal(world.row.smtp_host, 'smtp.example.test');
});

test('a widening that cannot connect answers 422 and leaves the row unchanged', async () => {
  reset('imap', { answer: { imap: 'ok', smtp: 'timeout' } });
  const before = { ...world.row };
  const res = await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 465 });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error_code, 'timeout');
  assert.equal(body.half, 'smtp');
  assert.equal(body.needs_login, undefined);
  assert.equal(writes().length, 0, 'nothing written');
  assert.deepEqual(world.row, before);
});

test('an added half with no host is refused before any dial', async () => {
  reset('imap');
  const res = await patch({ mode: 'both', smtpHost: '  ', smtpPort: 465 });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error_code, 'host_required');
  assert.equal(world.dials.length, 0);
  assert.equal(writes().length, 0);
});

test('a refused stored login asks for one; the supplied login is checked on every half and replaces the stored one', async () => {
  reset('imap', { answer: { imap: 'auth', smtp: 'auth' }, acceptedPassword: 'new-secret' });
  const first = await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 465 });
  assert.equal(first.status, 422);
  const refused = await first.json();
  assert.equal(refused.needs_login, true);
  assert.equal(refused.half, 'smtp');
  assert.equal(writes().length, 0);

  world.dials = [];
  const second = await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 465, username: '', appPassword: 'new-secret' });
  assert.equal(second.status, 200, JSON.stringify(await second.clone().json()));
  assert.deepEqual(world.dials.map((d) => d.protocol), ['imap', 'smtp'], 'the shared password is checked on both halves');
  assert.ok(world.dials.every((d) => d.password === 'new-secret' && d.username === undefined));
  assert.equal(world.row.imap_password, 'enc:new-secret');
  assert.equal(world.row.imap_username, null);
  assert.equal(world.row.status, 'active');
  assertScopedToInbox();
});

test('switch receive only to send only: dials SMTP, clears IMAP', async () => {
  reset('imap');
  const res = await patch({ mode: 'smtp', smtpHost: 'smtp.example.test', smtpPort: 465 });
  assert.equal(res.status, 200);
  assert.deepEqual(world.dials.map((d) => d.protocol), ['smtp']);
  assert.equal(world.row.imap_host, null);
  assert.equal(world.row.smtp_host, 'smtp.example.test');
  assertScopedToInbox();
});

test('the stored type again is a no-op', async () => {
  const res = await patch({ mode: 'both' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).unchanged, true);
  assert.equal(writes().length, 0);
  assert.equal(world.dials.length, 0);
});

test('an added host on another domain needs the password typed: 422 before any dial', async () => {
  reset('imap');
  const res = await patch({ mode: 'both', smtpHost: 'smtp.attacker.example', smtpPort: 465, smtpSecurity: 'tls' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error_code, 'password_required');
  assert.equal(body.half, 'smtp');
  assert.equal(body.needs_login, true);
  assert.equal(JSON.stringify(body).includes('secret'), false);
  assert.equal(world.dials.length, 0, 'the stored password is never sent to it');
  assert.equal(writes().length, 0);
});

test('an added host on the saved host\'s registrable domain dials with the stored password', async () => {
  reset('imap');
  const res = await patch({ mode: 'both', smtpHost: 'mail.out.example.test.', smtpPort: 465, smtpSecurity: 'tls' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(world.dials.map((d) => [d.protocol, d.password]), [['smtp', 'stored-secret']]);
});

test('an added host on another domain dials once the password is supplied', async () => {
  reset('smtp');
  const res = await patch({ mode: 'both', imapHost: 'imap.other.example', imapPort: 993, imapSecurity: 'tls', username: 'box-login', appPassword: 'typed-secret' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(world.dials.map((d) => d.protocol), ['imap', 'smtp']);
  assert.ok(world.dials.every((d) => d.password === 'typed-secret'), 'only the typed password is sent');
  assert.equal(world.row.imap_host, 'imap.other.example');
  assert.equal(world.row.imap_password, 'enc:typed-secret');
});

test('an IP host matches only the same IP, never a shared suffix', async () => {
  reset('imap', { row: { ...storedRow('imap'), imap_host: '203.0.113.5' } });
  const res = await patch({ mode: 'both', smtpHost: '198.51.113.5', smtpPort: 465 });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error_code, 'password_required');
  assert.equal(world.dials.length, 0);
});

test('security none on an added half is refused, with or without a password', async () => {
  for (const extra of [{}, { appPassword: 'typed-secret' }]) {
    reset('imap');
    const res = await patch({ mode: 'both', smtpHost: 'smtp.example.test', smtpPort: 25, smtpSecurity: 'none', ...extra });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error_code, 'insecure_security');
    assert.equal(world.dials.length, 0);
    assert.equal(writes().length, 0);
  }
});
