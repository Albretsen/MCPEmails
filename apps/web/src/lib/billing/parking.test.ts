/**
 * Tests for inbox parking (src/lib/billing/parking.ts).
 *
 * What a broken version would cost: a paying customer's mailbox parked in the
 * wrong order, a parked mailbox still running automations, a rule paused for
 * the Free allowance resumed by an upgrade that did not lift the allowance, or
 * another workspace's inboxes touched. Each of those is asserted below.
 *
 * NOTHING HERE TOUCHES A NETWORK. The Supabase client is the in-memory fake in
 * ./fake-supabase.ts.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/billing/parking.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import {
  INBOX_PARKED_PAUSED_UNTIL,
  INBOX_PARKED_PAUSE_REASON,
  PARKED_REASON_PLAN_LIMIT,
  chooseActiveInboxes,
  parkAboveCap,
  unparkUpToCap,
} from '@/lib/billing/parking';

const WS = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-11-10T09:00:00.000Z');
const EARLIER = '2026-11-01T00:00:00.000Z';

function inbox(id: string, workspaceId: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, workspace_id: workspaceId, created_at: createdAt, deleted_at: null, parked_at: null, parked_reason: null, ...extra };
}

function rule(id: string, workspaceId: string, inboxId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: workspaceId,
    inbox_id: inboxId,
    enabled: true,
    deleted_at: null,
    paused_reason: null,
    paused_until: null,
    next_run_at: EARLIER,
    ...extra,
  };
}

/** Four inboxes in WS (a oldest), one in OTHER; usage: c busiest, then b. */
function seeded(): FakeSupabase {
  const db = new FakeSupabase();
  db.seed('inboxes', [
    inbox('a', WS, '2026-01-01T00:00:00.000Z'),
    inbox('b', WS, '2026-02-01T00:00:00.000Z'),
    inbox('c', WS, '2026-03-01T00:00:00.000Z'),
    inbox('d', WS, '2026-04-01T00:00:00.000Z'),
    inbox('x', OTHER, '2025-01-01T00:00:00.000Z'),
  ]);
  const calls: Record<string, Array<{ inbox_id: string; calls: number; last_success_at: string | null }>> = {
    [WS]: [
      { inbox_id: 'c', calls: 90, last_success_at: null },
      { inbox_id: 'b', calls: 40, last_success_at: null },
    ],
    [OTHER]: [{ inbox_id: 'x', calls: 500, last_success_at: null }],
  };
  db.onRpc('workspace_inbox_activity', (args) => {
    assert.equal(args.p_days, 30, 'usage is ranked over 30 days');
    return { data: calls[String(args.p_workspace_id)] ?? [], error: null };
  });
  return db;
}

function row(db: FakeSupabase, table: string, id: string) {
  const found = db.table(table).find((r) => r.id === id);
  assert.ok(found, `${table} ${id} is seeded`);
  return found;
}

const parkedIds = (db: FakeSupabase, workspaceId = WS) =>
  db.table('inboxes').filter((r) => r.workspace_id === workspaceId && r.parked_at).map((r) => r.id).sort();

// ── chooseActiveInboxes ─────────────────────────────────────────────────────

test('choice: most used first, then oldest, and a tie never depends on input order', () => {
  const rows = [
    { id: 'd', created_at: '2026-04-01', calls: 0 },
    { id: 'a', created_at: '2026-01-01', calls: 0 },
    { id: 'c', created_at: '2026-03-01', calls: 90 },
    { id: 'b', created_at: '2026-02-01', calls: 40 },
  ];
  const { active, parked } = chooseActiveInboxes(rows, 3);
  assert.deepEqual(active.map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(parked.map((r) => r.id), ['d']);
  assert.deepEqual(chooseActiveInboxes([...rows].reverse(), 3).active.map((r) => r.id), ['c', 'b', 'a']);
});

test('choice: the preferred order wins over usage, and unknown ids are ignored', () => {
  const rows = [
    { id: 'a', created_at: '2026-01-01', calls: 0 },
    { id: 'c', created_at: '2026-03-01', calls: 90 },
    { id: 'd', created_at: '2026-04-01', calls: 0 },
  ];
  const { active } = chooseActiveInboxes(rows, 2, ['nope', 'd', 'a']);
  assert.deepEqual(active.map((r) => r.id), ['d', 'a']);
});

test('choice: an inbox already active outranks a parked one with more usage', () => {
  const rows = [
    { id: 'a', created_at: '2026-01-01', calls: 1, parked_at: null },
    { id: 'c', created_at: '2026-03-01', calls: 90, parked_at: EARLIER },
  ];
  assert.deepEqual(chooseActiveInboxes(rows, 1).active.map((r) => r.id), ['a']);
});

test('choice: no cap keeps everything; a cap of 0 or below parks everything', () => {
  const rows = [{ id: 'a', created_at: '2026-01-01' }, { id: 'b', created_at: '2026-02-01' }];
  assert.equal(chooseActiveInboxes(rows, null).parked.length, 0);
  assert.equal(chooseActiveInboxes(rows, Infinity).parked.length, 0);
  assert.equal(chooseActiveInboxes(rows, 0).active.length, 0);
  assert.equal(chooseActiveInboxes(rows, -2).active.length, 0);
});

// ── parkAboveCap ────────────────────────────────────────────────────────────

test('park: keeps the most used up to the cap and parks the rest with the reason', async () => {
  const db = seeded();
  const result = await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  assert.equal(result.failed, false);
  assert.deepEqual(result.active, ['c']);
  assert.deepEqual([...result.newlyParked].sort(), ['a', 'b', 'd']);
  assert.deepEqual(parkedIds(db), ['a', 'b', 'd']);
  assert.equal(row(db, 'inboxes', 'a').parked_at, NOW.toISOString());
  assert.equal(row(db, 'inboxes', 'a').parked_reason, PARKED_REASON_PLAN_LIMIT);
  assert.equal(row(db, 'inboxes', 'c').parked_at, null);
});

test('park: the customer order is respected', async () => {
  const db = seeded();
  const result = await parkAboveCap(asClient(db), WS, 2, ['d', 'a'], { now: NOW });
  assert.deepEqual(result.active, ['d', 'a']);
  assert.deepEqual(parkedIds(db), ['b', 'c']);
});

test('park: a second run is a no-op and keeps the original parked_at', async () => {
  const db = seeded();
  db.seed('triage_rules', [rule('r1', WS, 'a')]);
  await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  const later = new Date(NOW.getTime() + 3_600_000);
  const replay = await parkAboveCap(asClient(db), WS, 1, [], { now: later });
  assert.deepEqual(replay.newlyParked, []);
  assert.deepEqual(replay.unparked, []);
  assert.equal(replay.rulesPaused, 0);
  assert.equal(replay.failed, false);
  assert.equal(row(db, 'inboxes', 'a').parked_at, NOW.toISOString());
});

test('park: never touches another workspace, even with a bigger usage number there', async () => {
  const db = seeded();
  db.seed('triage_rules', [rule('rx', OTHER, 'x')]);
  await parkAboveCap(asClient(db), WS, 0, [], { now: NOW });
  assert.equal(row(db, 'inboxes', 'x').parked_at, null);
  assert.equal(row(db, 'triage_rules', 'rx').paused_reason, null);
  assert.deepEqual(parkedIds(db), ['a', 'b', 'c', 'd']);
});

test('park: rules on parked inboxes pause until unparked; rules on active inboxes are untouched', async () => {
  const db = seeded();
  db.seed('triage_rules', [
    rule('on-c', WS, 'c'),
    rule('on-a', WS, 'a'),
    rule('on-a-off', WS, 'a', { enabled: false, next_run_at: null }),
    rule('on-b-capped', WS, 'b', { paused_reason: 'plan_limit', paused_until: '2026-12-01T00:00:00.000Z' }),
    rule('on-d-deleted', WS, 'd', { deleted_at: EARLIER }),
  ]);
  const result = await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  assert.equal(result.rulesPaused, 3);
  for (const id of ['on-a', 'on-a-off', 'on-b-capped']) {
    assert.equal(row(db, 'triage_rules', id).paused_reason, INBOX_PARKED_PAUSE_REASON, id);
    assert.equal(row(db, 'triage_rules', id).paused_until, INBOX_PARKED_PAUSED_UNTIL, id);
  }
  assert.equal(row(db, 'triage_rules', 'on-c').paused_reason, null);
  assert.equal(row(db, 'triage_rules', 'on-d-deleted').paused_reason, null);
});

test('park: a swap through the preferred order unparks one and parks another, rules follow', async () => {
  const db = seeded();
  db.seed('triage_rules', [rule('on-a', WS, 'a'), rule('on-c', WS, 'c')]);
  await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  const swap = await parkAboveCap(asClient(db), WS, 1, ['a'], { now: NOW });
  assert.deepEqual(swap.active, ['a']);
  assert.deepEqual(swap.newlyParked, ['c']);
  assert.deepEqual(swap.unparked, ['a']);
  assert.equal(row(db, 'triage_rules', 'on-a').paused_reason, null);
  assert.equal(row(db, 'triage_rules', 'on-a').next_run_at, NOW.toISOString());
  assert.equal(row(db, 'triage_rules', 'on-c').paused_reason, INBOX_PARKED_PAUSE_REASON);
});

test('park: no cap parks nothing', async () => {
  const db = seeded();
  const result = await parkAboveCap(asClient(db), WS, null, [], { now: NOW });
  assert.deepEqual(result.newlyParked, []);
  assert.deepEqual(parkedIds(db), []);
});

test('park: a failed inbox read changes nothing and reports failure without throwing', async () => {
  const db = seeded();
  db.failOnce('inboxes', { message: 'boom' });
  const result = await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  assert.equal(result.failed, true);
  assert.deepEqual(parkedIds(db), []);
});

test('park: a failed usage read falls back to the oldest inboxes', async () => {
  const db = seeded();
  db.onRpc('workspace_inbox_activity', () => ({ data: null, error: { message: 'timeout' } }));
  const result = await parkAboveCap(asClient(db), WS, 2, [], { now: NOW });
  assert.equal(result.failed, false);
  assert.deepEqual(result.active, ['a', 'b']);
});

test('park: a failed rule write is reported and a re-run repairs it', async () => {
  const db = seeded();
  db.seed('triage_rules', [rule('on-a', WS, 'a')]);
  db.failOnce('triage_rules', { message: 'boom' });
  const first = await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  assert.equal(first.failed, true);
  assert.equal(row(db, 'triage_rules', 'on-a').paused_reason, null);
  const repair = await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  assert.equal(repair.failed, false);
  assert.equal(repair.rulesPaused, 1);
  assert.equal(row(db, 'triage_rules', 'on-a').paused_reason, INBOX_PARKED_PAUSE_REASON);
});

// ── unparkUpToCap ───────────────────────────────────────────────────────────

test('unpark: up to the new cap, in usage order, resuming only parking pauses', async () => {
  const db = seeded();
  db.seed('triage_rules', [
    rule('on-b', WS, 'b'),
    rule('on-a', WS, 'a'),
    rule('on-a-off', WS, 'a', { enabled: false, next_run_at: null }),
  ]);
  await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  // A plan-limit pause written while parked must survive the unpark.
  Object.assign(row(db, 'triage_rules', 'on-a'), { paused_reason: 'plan_limit', paused_until: '2026-12-01T00:00:00.000Z' });

  const result = await unparkUpToCap(asClient(db), WS, 3, [], { now: NOW });
  assert.equal(result.failed, false);
  assert.deepEqual(result.unparked, ['b', 'a']);
  assert.deepEqual(parkedIds(db), ['d']);
  assert.equal(row(db, 'inboxes', 'b').parked_reason, null);
  assert.equal(row(db, 'triage_rules', 'on-b').paused_reason, null);
  assert.equal(row(db, 'triage_rules', 'on-b').paused_until, null);
  assert.equal(row(db, 'triage_rules', 'on-b').next_run_at, NOW.toISOString());
  assert.equal(row(db, 'triage_rules', 'on-a').paused_reason, 'plan_limit');
  assert.equal(row(db, 'triage_rules', 'on-a-off').paused_reason, null);
  assert.equal(row(db, 'triage_rules', 'on-a-off').next_run_at, null, 'a disabled rule stays unscheduled');
  assert.equal(result.rulesResumed, 2);
});

test('unpark: no cap brings every inbox back; a replay is a no-op', async () => {
  const db = seeded();
  await parkAboveCap(asClient(db), WS, 0, [], { now: NOW });
  const all = await unparkUpToCap(asClient(db), WS, Infinity, [], { now: NOW });
  assert.equal(all.unparked.length, 4);
  assert.deepEqual(parkedIds(db), []);
  const replay = await unparkUpToCap(asClient(db), WS, null, [], { now: NOW });
  assert.deepEqual(replay.unparked, []);
  assert.equal(replay.rulesResumed, 0);
});

test('unpark: the customer order decides which come back', async () => {
  const db = seeded();
  await parkAboveCap(asClient(db), WS, 1, [], { now: NOW });
  const result = await unparkUpToCap(asClient(db), WS, 2, ['d'], { now: NOW });
  assert.deepEqual(result.unparked, ['d']);
  assert.deepEqual(parkedIds(db), ['a', 'b']);
});

test('unpark: never parks, even when more are active than the cap', async () => {
  const db = seeded();
  const result = await unparkUpToCap(asClient(db), WS, 1, [], { now: NOW });
  assert.deepEqual(result.unparked, []);
  assert.deepEqual(parkedIds(db), []);
});

test('unpark: never touches another workspace', async () => {
  const db = seeded();
  await parkAboveCap(asClient(db), OTHER, 0, [], { now: NOW });
  await parkAboveCap(asClient(db), WS, 0, [], { now: NOW });
  await unparkUpToCap(asClient(db), WS, null, [], { now: NOW });
  assert.deepEqual(parkedIds(db, OTHER), ['x']);
});
