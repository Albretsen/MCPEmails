// ---------------------------------------------------------------------------
// The immediate kick: lifecycle-queue.ts dispatches the rows it just queued
// with send_after <= now, after the response, and never fails its caller.
//
// The scheduler (Next's after()) and the runner (the real dispatch) are
// replaced, so this asserts which ids would be dispatched without sending.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/billing/dispatch-kick.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import { dueIds, kickDueRows, setDispatchKickForTests } from '@/lib/billing/dispatch-kick';
import {
  cancelDunningForCustomer,
  queueCancellationSequence,
  queuePauseEmails,
  queuePauseReminder,
} from '@/lib/billing/lifecycle-queue';

const target = { stripeCustomerId: 'cus_k', userId: null, recipient: 'person@example.test' };
const DAY = 86_400;

let scheduled: Array<() => Promise<void>> = [];
let dispatched: number[][] = [];
const quiet = { warn: console.warn, error: console.error, log: console.log };

beforeEach(() => {
  process.env.BILLING_LIFECYCLE_EMAILS = 'on';
  scheduled = [];
  dispatched = [];
  setDispatchKickForTests({
    scheduler: (task) => {
      scheduled.push(task);
    },
    runner: async (ids) => {
      dispatched.push(ids);
    },
  });
  console.log = () => {};
});

afterEach(() => {
  setDispatchKickForTests({ scheduler: null, runner: null });
  Object.assign(console, quiet);
});

async function runScheduled() {
  for (const task of scheduled) await task();
}

function ids(db: FakeSupabase, template: string): number[] {
  return db.table('billing_email_sends').filter((r) => r.template === template).map((r) => Number(r.id));
}

test('the cancellation question is kicked; the win-backs weeks away are not', async () => {
  const db = new FakeSupabase();
  const periodEnd = Math.floor(Date.now() / 1000) + 20 * DAY;

  const queued = await queueCancellationSequence({
    db: asClient(db),
    target,
    subscriptionId: 'sub_k',
    periodEndSeconds: periodEnd,
    payload: {},
  });
  assert.equal(queued, 3);
  await runScheduled();

  assert.deepEqual(dispatched, [ids(db, 'cancel_ask')]);
});

test('a replay inserts nothing and kicks nothing', async () => {
  const db = new FakeSupabase();
  const options = { db: asClient(db), target, subscriptionId: 'sub_k', periodEndSeconds: null, payload: {} };
  await queueCancellationSequence(options);
  scheduled = [];

  assert.equal(await queueCancellationSequence(options), 0);
  assert.equal(scheduled.length, 0);
});

test('the pause receipt is kicked; the 3-day reminder is not', async () => {
  const db = new FakeSupabase();
  const now = Math.floor(Date.now() / 1000);

  await queuePauseEmails({
    db: asClient(db),
    target,
    subscriptionId: 'sub_p',
    pausedFromSeconds: now,
    billsAtSeconds: now + 30 * DAY,
    payload: {},
  });
  await runScheduled();

  assert.deepEqual(dispatched, [ids(db, 'pause_started')]);
  assert.equal(ids(db, 'pause_ending_3').length, 1);
});

test('a reminder on its own schedules no kick at all', async () => {
  const db = new FakeSupabase();
  const now = Math.floor(Date.now() / 1000);

  const queued = await queuePauseReminder({
    db: asClient(db),
    target,
    subscriptionId: 'sub_r',
    billsAtSeconds: now + 30 * DAY,
    payload: {},
  });

  assert.equal(queued, 1);
  assert.equal(scheduled.length, 0);
});

test('dunning_14 brought forward on deletion is kicked', async () => {
  const db = new FakeSupabase();
  db.seed('billing_email_sends', [
    {
      stripe_customer_id: 'cus_k',
      template: 'dunning_14',
      scope_key: 'in_1',
      send_after: new Date(Date.now() + 10 * DAY * 1000).toISOString(),
      sent_at: null,
      cancelled_at: null,
    },
  ]);

  await cancelDunningForCustomer(asClient(db), 'cus_k', 'subscription_deleted');
  await runScheduled();

  assert.deepEqual(dispatched, [ids(db, 'dunning_14')]);
});

test('BILLING_LIFECYCLE_EMAILS=off schedules nothing', async () => {
  process.env.BILLING_LIFECYCLE_EMAILS = 'off';
  await kickDueRows([1, 2], 'test');
  assert.equal(scheduled.length, 0);
});

test('a scheduler that throws (no request scope) never reaches the caller', async () => {
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  setDispatchKickForTests({
    scheduler: () => {
      throw new Error('`after` was called outside a request scope');
    },
  });
  const db = new FakeSupabase();

  const queued = await queueCancellationSequence({
    db: asClient(db),
    target,
    subscriptionId: 'sub_x',
    periodEndSeconds: null,
    payload: {},
  });

  assert.equal(queued, 1);
  assert.equal(warnings.length, 1);
});

test('the default scheduler outside Next does not throw either', async () => {
  console.warn = () => {};
  setDispatchKickForTests({ scheduler: null });
  await kickDueRows([1], 'plain node');
  assert.equal(dispatched.length, 0);
});

test('a dispatch that fails inside the scheduled task is logged, not thrown', async () => {
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  setDispatchKickForTests({
    runner: async () => {
      throw new Error('stripe down');
    },
  });

  await kickDueRows([7], 'test');
  await runScheduled();

  assert.equal(errors.length, 1);
});

test('dueIds keeps only rows whose send_after is not in the future', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  assert.deepEqual(
    dueIds(
      [
        { id: 1, send_after: '2026-10-24T12:00:00.000Z' },
        { id: 2, send_after: '2026-10-24T11:00:00+00:00' },
        { id: 3, send_after: '2026-10-27T12:00:00.000Z' },
        { id: 4, send_after: null },
        { send_after: '2026-10-24T11:00:00.000Z' },
      ],
      now,
    ),
    [1, 2],
  );
  assert.deepEqual(dueIds(null), []);
});
