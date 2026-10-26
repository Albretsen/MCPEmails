import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_DAILY_CAP,
  ACTIVATION_EVENT_STAGES,
  handleActivationEventRequest,
  parseActivationEvent,
  recordActivationEvent,
  type ActivationRequestDeps,
} from './activation-events.ts';

type Filter = [string, string, unknown];

/**
 * A fake client. `recent` answers the dedupe lookup, `count` the daily-cap
 * count; inserts and every lookup's filters are captured.
 */
function fakeDb({ recent = null as unknown, count = 0, lookupError = null as null | { message: string } } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const dedupeLookups: Filter[][] = [];
  const countLookups: Filter[][] = [];
  const db = {
    from(table: string) {
      const filters: Filter[] = [];
      let head = false;
      const chain: Record<string, unknown> = {
        select(_cols: string, opts?: { head?: boolean }) { head = Boolean(opts?.head); return chain; },
        eq(col: string, v: unknown) { filters.push(['eq', col, v]); return chain; },
        is(col: string, v: unknown) { filters.push(['is', col, v]); return chain; },
        gte(col: string, v: unknown) { filters.push(['gte', col, v]); return chain; },
        limit() { return chain; },
        maybeSingle() {
          dedupeLookups.push(filters);
          return Promise.resolve({ data: recent, error: lookupError });
        },
        then(resolve: (v: unknown) => void) {
          if (head) countLookups.push(filters);
          resolve({ count, error: null });
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { db: db as never, inserts, dedupeLookups, countLookups };
}

test('only the five activation stages are accepted', () => {
  assert.deepEqual([...ACTIVATION_EVENT_STAGES], [
    'connect_fix_shown', 'connect_fix_link_clicked', 'first_call_prompt_copied', 'waiting_state_shown',
    'install_link_clicked',
  ]);
  assert.deepEqual(parseActivationEvent({ stage: 'install_link_clicked', client: 'cursor' }), {
    stage: 'install_link_clicked', category: 'cursor', authReason: null, phase: null,
  });
  assert.equal(parseActivationEvent({ stage: 'install_link_clicked', client: 'not-a-client' }), null);
  for (const stage of ['inbox_connection', 'checkout_completed', 'first_tool_call', 'CONNECT_FIX_SHOWN', '', null, 1]) {
    assert.equal(parseActivationEvent({ stage, provider: 'gmail', client: 'claude' }), null, String(stage));
  }
  for (const junk of [null, undefined, 'connect_fix_shown', 42, []]) {
    assert.equal(parseActivationEvent(junk), null);
  }
});

test('connect_fix_* need a known provider and keep only known reason and phase', () => {
  assert.deepEqual(
    parseActivationEvent({ stage: 'connect_fix_shown', provider: 'gmail', auth_reason: 'account_password_used', phase: 'authentication' }),
    { stage: 'connect_fix_shown', category: 'gmail', authReason: 'account_password_used', phase: 'authentication' },
  );
  assert.deepEqual(
    parseActivationEvent({ stage: 'connect_fix_link_clicked', provider: 'yahoo', auth_reason: 'smtp.example.com', phase: 'imap.example.com:993' }),
    { stage: 'connect_fix_link_clicked', category: 'yahoo', authReason: null, phase: null },
  );
  // A client is not a provider, and a provider stage never falls back to one.
  assert.equal(parseActivationEvent({ stage: 'connect_fix_shown', provider: 'claude' }), null);
  assert.equal(parseActivationEvent({ stage: 'connect_fix_shown', client: 'claude' }), null);
  assert.equal(parseActivationEvent({ stage: 'connect_fix_shown', provider: 'ionos' }), null);
});

test('first-call stages need a known client and drop reason and phase', () => {
  assert.deepEqual(
    parseActivationEvent({ stage: 'first_call_prompt_copied', client: 'claude', auth_reason: 'imap_disabled', phase: 'tcp' }),
    { stage: 'first_call_prompt_copied', category: 'claude', authReason: null, phase: null },
  );
  assert.deepEqual(
    parseActivationEvent({ stage: 'waiting_state_shown', client: 'chatgpt' }),
    { stage: 'waiting_state_shown', category: 'chatgpt', authReason: null, phase: null },
  );
  assert.equal(parseActivationEvent({ stage: 'waiting_state_shown', client: 'gmail' }), null);
  assert.equal(parseActivationEvent({ stage: 'waiting_state_shown' }), null);
});

test('a new event writes one success row with the copied reason and phase', async () => {
  const { db, inserts, dedupeLookups } = fakeDb();
  const now = new Date('2026-10-24T12:00:00Z');
  const result = await recordActivationEvent(db, 'ws-1', {
    stage: 'connect_fix_shown', category: 'gmail', authReason: 'account_password_used', phase: 'authentication',
  }, now);
  assert.equal(result, 'recorded');
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], {
    table: 'product_funnel_events', workspace_id: 'ws-1', stage: 'connect_fix_shown', outcome: 'success',
    category: 'gmail', error_category: null, phase: 'authentication', connection_type: null,
    auth_reason: 'account_password_used',
  });
  assert.deepEqual(dedupeLookups[0], [
    ['eq', 'workspace_id', 'ws-1'], ['eq', 'stage', 'connect_fix_shown'], ['eq', 'category', 'gmail'],
    ['gte', 'occurred_at', '2026-10-24T11:58:00.000Z'], ['eq', 'auth_reason', 'account_password_used'],
  ]);
});

test('waiting_state_shown is deduped over a whole day', async () => {
  const { db, inserts, dedupeLookups } = fakeDb({ recent: { id: 9 } });
  const now = new Date('2026-10-24T12:00:00Z');
  const result = await recordActivationEvent(db, 'ws-1', {
    stage: 'waiting_state_shown', category: 'claude', authReason: null, phase: null,
  }, now);
  assert.equal(result, 'deduped');
  assert.equal(inserts.length, 0);
  assert.deepEqual(dedupeLookups[0][3], ['gte', 'occurred_at', '2026-10-23T12:00:00.000Z']);
});

test('the daily cap stops a flood even when no row is identical', async () => {
  const { db, inserts, countLookups } = fakeDb({ count: ACTIVATION_DAILY_CAP });
  const result = await recordActivationEvent(db, 'ws-1', {
    stage: 'first_call_prompt_copied', category: 'claude', authReason: null, phase: null,
  });
  assert.equal(result, 'capped');
  assert.equal(inserts.length, 0);
  assert.equal(countLookups.length, 1);
});

test('a failed dedupe lookup writes nothing', async () => {
  const { db, inserts } = fakeDb({ lookupError: { message: 'boom' } });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await recordActivationEvent(db, 'ws-1', {
      stage: 'connect_fix_link_clicked', category: 'yahoo', authReason: null, phase: null,
    });
    assert.equal(result, 'lookup_failed');
  } finally {
    console.error = originalError;
  }
  assert.equal(inserts.length, 0);
});

function deps(over: Partial<ActivationRequestDeps> & { fake?: ReturnType<typeof fakeDb> } = {}) {
  const fake = over.fake ?? fakeDb();
  const seen: string[] = [];
  return {
    fake,
    seen,
    deps: {
      userId: over.userId ?? (async () => 'user-1'),
      workspaceId: over.workspaceId ?? (async (userId: string) => { seen.push(userId); return 'ws-from-session'; }),
      db: () => fake.db,
    } satisfies ActivationRequestDeps,
  };
}

test('the request handler refuses bad input, anonymous callers and users with no workspace', async () => {
  const { deps: d1, fake: f1 } = deps();
  assert.equal(await handleActivationEventRequest({ stage: 'checkout_completed', provider: 'gmail' }, d1), 400);
  assert.equal(await handleActivationEventRequest(null, d1), 400);
  assert.equal(f1.inserts.length, 0);

  const { deps: d2, fake: f2 } = deps({ userId: async () => null });
  assert.equal(await handleActivationEventRequest({ stage: 'waiting_state_shown', client: 'claude' }, d2), 401);
  assert.equal(f2.inserts.length, 0);

  const { deps: d3, fake: f3 } = deps({ workspaceId: async () => null });
  assert.equal(await handleActivationEventRequest({ stage: 'waiting_state_shown', client: 'claude' }, d3), 404);
  assert.equal(f3.inserts.length, 0);
});

test('the workspace comes from the session, never from the body', async () => {
  const { deps: d, fake, seen } = deps();
  const status = await handleActivationEventRequest(
    { stage: 'waiting_state_shown', client: 'claude', workspace_id: 'ws-someone-else', workspaceId: 'ws-someone-else' },
    d,
  );
  assert.equal(status, 204);
  assert.deepEqual(seen, ['user-1']);
  assert.equal(fake.inserts.length, 1);
  assert.equal(fake.inserts[0].workspace_id, 'ws-from-session');
});
