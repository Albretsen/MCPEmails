/**
 * Tests for lifting plan-limit pauses on automations.
 *
 * The defect these pin: a rule paused for the Free allowance stays paused until
 * the end of the allowance period, and nothing re-read that pause when the
 * customer paid. The module under test is the write that fixes it, and it sits
 * beside billing writes that matter more than it does, so half of what is
 * asserted here is what it must NOT do: touch another workspace, touch a rule
 * paused for any other reason, move a schedule twice, or throw.
 *
 * NOTHING HERE TOUCHES A NETWORK. The Supabase client is the in-memory fake in
 * ./fake-supabase.ts.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/billing/plan-limit-pauses.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import {
  RESUME_RULES_PER_MINUTE,
  RESUME_WINDOW_MINUTES,
  liftPlanLimitPauses,
  resumeSlots,
  workspacesEnteringPaidPlan,
} from '@/lib/billing/plan-limit-pauses';

const UPGRADED = '00000000-0000-4000-8000-0000000000a1';
const BYSTANDER = '00000000-0000-4000-8000-0000000000b2';
const OWNER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-01T09:00:00.000Z');
const PERIOD_END = '2026-11-01T00:00:00.000Z';

/** A rule exactly as pauseRuleForPlanLimit leaves it. */
function pausedRule(id: string, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: workspaceId,
    enabled: true,
    deleted_at: null,
    disabled_reason: null,
    consecutive_failures: 2,
    interval_minutes: 60,
    paused_reason: 'plan_limit',
    paused_until: PERIOD_END,
    next_run_at: PERIOD_END,
    ...overrides,
  };
}

function rule(db: FakeSupabase, id: string) {
  const row = db.table('triage_rules').find((r) => r.id === id);
  assert.ok(row, `rule ${id} is seeded`);
  return row;
}

function minutesAfterNow(iso: unknown): number {
  return (new Date(String(iso)).getTime() - NOW.getTime()) / 60_000;
}

// ---------------------------------------------------------------------------
// The lift
// ---------------------------------------------------------------------------

test('a paused rule is un-paused and made due now', async () => {
  const db = new FakeSupabase();
  db.seed('triage_rules', [pausedRule('rule-1', UPGRADED)]);

  const result = await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });

  assert.deepEqual(result, { lifted: 1, failed: false });
  const row = rule(db, 'rule-1');
  assert.equal(row.paused_reason, null);
  assert.equal(row.paused_until, null);
  assert.equal(row.next_run_at, NOW.toISOString(), 'due on the next dispatcher cycle');
});

test('the lift leaves enabled, disabled_reason and consecutive_failures alone', async () => {
  const db = new FakeSupabase();
  db.seed('triage_rules', [pausedRule('rule-1', UPGRADED)]);
  const before = { ...rule(db, 'rule-1') };

  await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });

  const after = rule(db, 'rule-1');
  const changed = Object.keys(after).filter((key) => after[key] !== before[key]).sort();
  assert.deepEqual(changed, ['next_run_at', 'paused_reason', 'paused_until']);
});

test('another workspace, another pause reason and a deleted rule are not touched', async () => {
  const db = new FakeSupabase();
  db.seed('triage_rules', [
    pausedRule('upgraded', UPGRADED),
    // Still on Free and still out of allowance: must stay paused.
    pausedRule('bystander', BYSTANDER),
    // 'plan_limit' is the only reason today. A future one is not ours to clear.
    pausedRule('other-reason', UPGRADED, { paused_reason: 'owner_request' }),
    pausedRule('deleted', UPGRADED, { deleted_at: '2026-09-20T00:00:00.000Z', enabled: false, next_run_at: null }),
    // Not paused at all: its schedule is its own.
    pausedRule('running-normally', UPGRADED, {
      paused_reason: null,
      paused_until: null,
      next_run_at: '2026-10-01T09:40:00.000Z',
    }),
  ]);
  const untouched = ['bystander', 'other-reason', 'deleted', 'running-normally'];
  const before = new Map(untouched.map((id) => [id, { ...rule(db, id) }]));

  const result = await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });

  assert.equal(result.lifted, 1);
  assert.equal(rule(db, 'upgraded').paused_reason, null);
  for (const id of untouched) assert.deepEqual(rule(db, id), before.get(id), id);
});

test('a rule the user switched off while paused loses the pause but is not scheduled', async () => {
  const db = new FakeSupabase();
  db.seed('triage_rules', [
    pausedRule('switched-off', UPGRADED, { enabled: false, next_run_at: null }),
  ]);

  const result = await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });

  assert.equal(result.lifted, 1);
  const row = rule(db, 'switched-off');
  assert.equal(row.paused_reason, null);
  assert.equal(row.paused_until, null);
  assert.equal(row.enabled, false);
  assert.equal(row.next_run_at, null, 'off means not scheduled');
});

test('120 paused rules resume inside the window, never more than a slot at a time', async () => {
  const db = new FakeSupabase();
  db.seed(
    'triage_rules',
    Array.from({ length: 120 }, (_, i) => pausedRule(`rule-${String(i).padStart(3, '0')}`, UPGRADED)),
  );

  const result = await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });

  assert.equal(result.lifted, 120);
  const perMinute = new Map<number, number>();
  for (const row of db.table('triage_rules')) {
    assert.equal(row.paused_until, null);
    const minute = minutesAfterNow(row.next_run_at);
    assert.ok(minute >= 0 && minute < RESUME_WINDOW_MINUTES, `minute ${minute} is inside the window`);
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
  }
  assert.equal(Math.max(...perMinute.values()), RESUME_RULES_PER_MINUTE);
  assert.equal(perMinute.size, 12, '120 rules at 10 a minute');
  assert.equal(perMinute.get(0), RESUME_RULES_PER_MINUTE, 'the first slot is now');
});

test('resumeSlots widens the slot rather than the window for a very large backlog', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `rule-${i}`);
  const slots = resumeSlots(ids, NOW);
  assert.equal(slots.length, RESUME_WINDOW_MINUTES);
  assert.equal(slots.flatMap((slot) => slot.ruleIds).length, 400, 'every rule gets a slot');
  assert.equal(slots[0].nextRunAt, NOW.toISOString());
  assert.equal(minutesAfterNow(slots.at(-1)?.nextRunAt), RESUME_WINDOW_MINUTES - 1);
  assert.deepEqual(resumeSlots([], NOW), []);
});

// ---------------------------------------------------------------------------
// Idempotency. Stripe retries and replays, and two events describe one purchase.
// ---------------------------------------------------------------------------

test('a second lift finds nothing to do and does not move a schedule again', async () => {
  const db = new FakeSupabase();
  db.seed('triage_rules', [pausedRule('rule-1', UPGRADED), pausedRule('rule-2', UPGRADED)]);

  await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });
  const afterFirst = db.table('triage_rules').map((row) => ({ ...row }));

  const replay = await liftPlanLimitPauses(asClient(db), [UPGRADED], {
    now: new Date(NOW.getTime() + 5 * 60_000),
  });

  assert.deepEqual(replay, { lifted: 0, failed: false });
  assert.deepEqual(db.table('triage_rules'), afterFirst);
});

test('no workspaces means no query at all', async () => {
  const db = new FakeSupabase();
  db.failOnce('triage_rules', { message: 'must not be reached' });
  assert.deepEqual(await liftPlanLimitPauses(asClient(db), [], { now: NOW }), { lifted: 0, failed: false });
  assert.equal(db.failNext.has('triage_rules'), true, 'the armed failure was never consumed');
});

// ---------------------------------------------------------------------------
// Containment. The callers have just written billing state.
// ---------------------------------------------------------------------------

test('a failed read is reported, not thrown, and leaves the rules as they were', async () => {
  const db = new FakeSupabase();
  db.seed('triage_rules', [pausedRule('rule-1', UPGRADED)]);
  db.failOnce('triage_rules', { message: 'connection reset' });

  const result = await liftPlanLimitPauses(asClient(db), [UPGRADED], { now: NOW });

  assert.deepEqual(result, { lifted: 0, failed: true });
  assert.equal(rule(db, 'rule-1').paused_reason, 'plan_limit');
});

test('a client that throws outright is swallowed too', async () => {
  const exploding = {
    from() {
      throw new Error('fetch failed');
    },
  } as unknown as SupabaseClient<Database>;

  assert.deepEqual(await liftPlanLimitPauses(exploding, [UPGRADED], { now: NOW }), {
    lifted: 0,
    failed: true,
  });
  assert.deepEqual(await workspacesEnteringPaidPlan(exploding, OWNER, 'personal'), []);
});

// ---------------------------------------------------------------------------
// The transition test
// ---------------------------------------------------------------------------

test('only workspaces whose plan is about to change to a paid plan are returned', async () => {
  const db = new FakeSupabase();
  db.seed('workspaces', [
    { id: 'ws-free', owner_id: OWNER, plan: 'free', deleted_at: null },
    { id: 'ws-already-personal', owner_id: OWNER, plan: 'personal', deleted_at: null },
    { id: 'ws-deleted', owner_id: OWNER, plan: 'free', deleted_at: '2026-09-01T00:00:00.000Z' },
    { id: 'ws-someone-else', owner_id: 'another-owner', plan: 'free', deleted_at: null },
  ]);

  assert.deepEqual(await workspacesEnteringPaidPlan(asClient(db), OWNER, 'personal'), ['ws-free']);
  // An upgrade between paid plans raises the allowance as well.
  assert.deepEqual(
    (await workspacesEnteringPaidPlan(asClient(db), OWNER, 'pro')).sort(),
    ['ws-already-personal', 'ws-free'],
  );
});

test('a downgrade to Free and the keep-the-plan sentinel never lift anything', async () => {
  const db = new FakeSupabase();
  db.seed('workspaces', [{ id: 'ws-pro', owner_id: OWNER, plan: 'pro', deleted_at: null }]);
  // Armed so that a query, if one were made, would be visible.
  db.failOnce('workspaces', { message: 'must not be reached' });

  assert.deepEqual(await workspacesEnteringPaidPlan(asClient(db), OWNER, 'free'), []);
  assert.deepEqual(await workspacesEnteringPaidPlan(asClient(db), OWNER, null), []);
  assert.equal(db.failNext.has('workspaces'), true);
});

test('a failed workspace read returns no ids rather than throwing', async () => {
  const db = new FakeSupabase();
  db.seed('workspaces', [{ id: 'ws-free', owner_id: OWNER, plan: 'free', deleted_at: null }]);
  db.failOnce('workspaces', { message: 'timeout' });

  assert.deepEqual(await workspacesEnteringPaidPlan(asClient(db), OWNER, 'personal'), []);
});
