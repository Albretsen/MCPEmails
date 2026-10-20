// The Pro cap kill rule reads usage_limit_events; these pin which hits land
// there. Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/plans/inbox-cap-events.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { recordInboxCapHit, shouldRecordInboxCapHit } from './inbox-cap-events.ts';
import type { InboxLimitCheckResult } from './check-inbox-limit.ts';

function limit(over: Partial<InboxLimitCheckResult>): InboxLimitCheckResult {
  return {
    atLimit: true,
    plan: 'solo',
    planName: 'Pro',
    currentCount: 10,
    maxInboxes: 10,
    unlimitedInboxes: false,
    proUnlimitedInboxes: false,
    ...over,
  };
}

function fakeDb() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { rpc: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), { error: null }) } as any,
  };
}

test('a Pro workspace at its cap writes one inboxes row with the count and the cap', async () => {
  const { db, calls } = fakeDb();
  await recordInboxCapHit('ws1', limit({ currentCount: 10 }), db);
  assert.deepEqual(calls, [
    { name: 'record_inbox_cap_event', args: { p_workspace_id: 'ws1', p_plan: 'solo', p_inbox_count: 10, p_cap: 10 } },
  ]);
});

test('only Pro cap hits are recorded', () => {
  assert.equal(shouldRecordInboxCapHit(limit({})), true);
  // Not at the cap, an older plan cap, or uncapped: nothing.
  assert.equal(shouldRecordInboxCapHit(limit({ atLimit: false })), false);
  assert.equal(shouldRecordInboxCapHit(limit({ plan: 'free', maxInboxes: 1 })), false);
  assert.equal(shouldRecordInboxCapHit(limit({ plan: 'personal', maxInboxes: 3 })), false);
  assert.equal(shouldRecordInboxCapHit(limit({ atLimit: false, maxInboxes: null })), false);
});

test('no workspace, no write; and a failed write never throws', async () => {
  const { db, calls } = fakeDb();
  await recordInboxCapHit(null, limit({}), db);
  assert.equal(calls.length, 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broken = { rpc: async () => { throw new Error('db down'); } } as any;
  const originalError = console.error;
  console.error = () => {};
  try {
    await recordInboxCapHit('ws1', limit({}), broken);
  } finally {
    console.error = originalError;
  }
});
