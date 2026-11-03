// ---------------------------------------------------------------------------
// lib/inboxes/teardown.ts: the Google revoke shared by account and workspace
// deletion, and the cancel of mail queued for inboxes that go away.
//
// Run: npm run test:inbox-teardown
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ENCRYPTION_KEY ??= 'b'.repeat(64);

const { encryptToken } = await import('../crypto.ts');
const { cancelQueuedMail, revokeGmailGrantsForWorkspaces } = await import('./teardown.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { table: string; op: string; patch?: unknown; filters: Array<[string, string, unknown]> };

function fakeDb(rows: Array<Record<string, unknown>>, opts: { failSelect?: boolean } = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const make = (op: string, patch?: unknown) => {
      const call: Call = { table, op, patch, filters: [] };
      calls.push(call);
      const b: any = {};
      for (const name of ['select', 'order', 'range']) b[name] = () => b;
      for (const name of ['eq', 'is', 'in']) b[name] = (c: string, v: unknown) => (call.filters.push([name, c, v]), b);
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          op === 'select'
            ? opts.failSelect ? { data: null, error: { message: 'down' } } : { data: rows, error: null }
            : { data: null, error: null },
        ).then(resolve);
      return b;
    };
    return { select: () => make('select'), update: (patch: unknown) => make('update', patch) };
  };
  return { db: { from }, calls };
}

const rows = () => [
  { id: 'a', imap_host: null, oauth_refresh_token: encryptToken('r-a'), oauth_access_token: encryptToken('x-a') },
  { id: 'b', imap_host: null, oauth_refresh_token: null, oauth_access_token: encryptToken('x-b') },
  { id: 'c', imap_host: 'imap.gmail.com', oauth_refresh_token: null, oauth_access_token: null },
  { id: 'd', imap_host: null, oauth_refresh_token: 'not-ciphertext', oauth_access_token: null },
];

test('revokes each live Gmail OAuth grant once, preferring the refresh token', async () => {
  const { db, calls } = fakeDb(rows());
  const seen: string[] = [];
  const summary = await revokeGmailGrantsForWorkspaces(db, ['ws-1', 'ws-2'], {
    fetchImpl: async (url) => {
      seen.push(new URL(url).searchParams.get('token') ?? '');
      return new Response('');
    },
  });
  assert.deepEqual(seen.sort(), ['r-a', 'x-b']);
  assert.equal(summary.attempted, 3, 'the app-password inbox is skipped');
  assert.equal(summary.failed, 1, 'the undecryptable token counts as a failure, not a throw');
  const select = calls.find((c) => c.op === 'select')!;
  assert.deepEqual(
    select.filters.map(([op, col]) => `${op}:${col}`).sort(),
    ['eq:provider', 'in:workspace_id', 'is:deleted_at'],
  );
});

test('a provider outage or a failed lookup never throws', async () => {
  const down = fakeDb(rows());
  const summary = await revokeGmailGrantsForWorkspaces(down.db, ['ws-1'], {
    fetchImpl: async () => {
      throw new Error('Google is down');
    },
  });
  assert.equal(summary.failed, summary.attempted);
  const broken = fakeDb([], { failSelect: true });
  assert.deepEqual(await revokeGmailGrantsForWorkspaces(broken.db, ['ws-1']), { attempted: 0, failed: 0 });
});

test('no workspaces: no query at all', async () => {
  const { db, calls } = fakeDb(rows());
  await revokeGmailGrantsForWorkspaces(db, []);
  await cancelQueuedMail(db, { workspaceIds: [] });
  await cancelQueuedMail(db, { inboxIds: [] });
  assert.equal(calls.length, 0);
});

test('queued mail: pending sends are cancelled and pending approvals expired, message removed', async () => {
  const { db, calls } = fakeDb([]);
  await cancelQueuedMail(db, { inboxIds: ['in-1'] });
  const sends = calls.find((c) => c.table === 'scheduled_sends')!;
  const approvals = calls.find((c) => c.table === 'send_approvals')!;
  assert.equal((sends.patch as any).status, 'cancelled');
  assert.deepEqual((sends.patch as any).payload, {});
  assert.equal((sends.patch as any).payload_encrypted, true);
  assert.equal((approvals.patch as any).status, 'expired');
  assert.deepEqual((approvals.patch as any).payload, {});
  for (const call of [sends, approvals]) {
    assert.deepEqual(call.filters, [['in', 'inbox_id', ['in-1']], ['eq', 'status', 'pending']]);
  }
});

test('queued mail by workspace scopes on workspace_id', async () => {
  const { db, calls } = fakeDb([]);
  await cancelQueuedMail(db, { workspaceIds: ['ws-1'] });
  assert.ok(calls.every((c) => c.filters[0][1] === 'workspace_id'));
});
