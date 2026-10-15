// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/support/context.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const { buildTicketContext, loadTicketContext, toErrorCode } = await import('./context.ts');

const SECRET_COLUMNS = ['imap_password', 'oauth_access_token', 'oauth_refresh_token', 'imap_username', 'email_address', 'signature_html'];

/** Records every select list and filter; answers from fixed tables. */
function fakeClient(tables: Record<string, Array<Record<string, unknown>>>) {
  const selects: Record<string, string> = {};
  return {
    selects,
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => {
        selects[table] = cols;
        return b;
      };
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
      b.order = () => b;
      b.limit = () => b;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return b;
    },
  };
}

const tables = {
  workspace_members: [
    { user_id: 'u1', workspace_id: 'w1', joined_at: '2026-01-01' },
    { user_id: 'u1', workspace_id: 'w2', joined_at: '2026-02-01' },
    { user_id: 'u2', workspace_id: 'w3', joined_at: '2026-01-01' },
  ],
  workspaces: [
    { id: 'w1', plan: 'free', deleted_at: null },
    { id: 'w2', plan: 'solo', deleted_at: null },
    { id: 'w3', plan: 'pro', deleted_at: null },
  ],
  inboxes: [
    { workspace_id: 'w1', provider: 'imap', service: 'yahoo', imap_host: 'imap.mail.yahoo.com', status: 'error', last_error: 'AUTHENTICATIONFAILED\r\nInvalid credentials', deleted_at: null, imap_password: 'SECRETPW' },
    { workspace_id: 'w1', provider: 'gmail', service: null, imap_host: null, status: 'active', last_error: null, deleted_at: null, oauth_refresh_token: 'SECRETTOKEN' },
    { workspace_id: 'w1', provider: 'imap', service: 'other', imap_host: 'gone.example', status: 'active', last_error: null, deleted_at: '2026-03-01' },
    { workspace_id: 'w3', provider: 'outlook', service: null, imap_host: null, status: 'active', last_error: null, deleted_at: null },
  ],
};

test('earliest membership by default; only that workspace, only live inboxes', async () => {
  const client = fakeClient(tables);
  const ctx = await loadTicketContext(client as never, 'u1', null);
  assert.equal(ctx.workspace_id, 'w1');
  assert.equal(ctx.plan, 'free');
  assert.deepEqual(ctx.mailboxes, [
    { provider: 'imap', service: 'yahoo', host: 'imap.mail.yahoo.com', status: 'error', last_error_code: 'AUTHENTICATIONFAILED Invalid credentials' },
    { provider: 'gmail', service: null, host: null, status: 'active', last_error_code: null },
  ]);
});

test('the active-workspace cookie wins only when the user is a member of it', async () => {
  assert.equal((await loadTicketContext(fakeClient(tables) as never, 'u1', 'w2')).workspace_id, 'w2');
  assert.equal((await loadTicketContext(fakeClient(tables) as never, 'u1', 'w3')).workspace_id, 'w1');
});

test('no membership: empty context', async () => {
  const ctx = await loadTicketContext(fakeClient(tables) as never, 'nobody', null);
  assert.deepEqual(ctx, { workspace_id: null, plan: null, mailboxes: [], from: null, provider: null, code: null });
});

test('never reads or returns credential or content columns', async () => {
  const client = fakeClient(tables);
  const ctx = await loadTicketContext(client as never, 'u1', null);
  const serialized = JSON.stringify(ctx);
  assert.equal(serialized.includes('SECRET'), false);
  for (const col of SECRET_COLUMNS) {
    assert.equal(client.selects.inboxes.includes(col), false, col);
  }
  assert.equal(client.selects.inboxes, 'provider, service, imap_host, status, last_error');
});

test('buildTicketContext carries from/provider/code and caps mailboxes at 20', () => {
  const inboxes = Array.from({ length: 25 }, () => ({ provider: 'imap', service: null, imap_host: 'h', status: 'active', last_error: null }));
  const ctx = buildTicketContext({ workspaceId: 'w', plan: 'free', inboxes }, { from: 'help', provider: 'yahoo', code: 'x' });
  assert.equal(ctx.mailboxes.length, 20);
  assert.equal(ctx.from, 'help');
  assert.equal(ctx.provider, 'yahoo');
  assert.equal(ctx.code, 'x');
});

test('toErrorCode: one line, capped', () => {
  assert.equal(toErrorCode(null), null);
  assert.equal(toErrorCode('  '), null);
  assert.equal(toErrorCode('a\nb'), 'a b');
  assert.equal(toErrorCode('x'.repeat(500))!.length, 120);
});
