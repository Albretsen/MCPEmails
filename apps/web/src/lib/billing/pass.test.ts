// ---------------------------------------------------------------------------
// The 3-month Personal pass: end dates, stacking, the effective plan,
// eligibility, the kill switch, and the reads that must survive the table not
// existing yet. The webhook transitions are pinned end to end in
// app/api/stripe/webhook/route.personal-pass.test.ts.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/billing/pass.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from './fake-supabase.ts';
import {
  activeFromLive,
  canQueueAnotherPass,
  effectivePlan,
  getActivePass,
  hasEntitledSubscription,
  isPausedSubscriber,
  passCheckoutOpen,
  passEligibility,
  passEndsAt,
  passNoticesFor,
  personalPassMode,
  planPassWindow,
  reprojectUserPlan,
  type PassRow,
} from './pass.ts';

const USER = '00000000-0000-4000-8000-0000000000aa';

function iso(value: string): string {
  return new Date(value).toISOString();
}

function pass(overrides: Partial<PassRow> & Pick<PassRow, 'id' | 'starts_at' | 'ends_at'>): PassRow {
  return {
    user_id: USER,
    product: 'personal_pass_3m',
    plan: 'personal',
    stripe_checkout_session_id: `cs_${overrides.id}`,
    stripe_payment_intent_id: `pi_${overrides.id}`,
    amount_minor: 2900,
    currency: 'usd',
    status: 'active',
    reminder_queued_at: null,
    expired_at: null,
    refunded_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. End dates
// ---------------------------------------------------------------------------

test('a pass ends three calendar months later, at the same UTC instant', () => {
  assert.equal(passEndsAt(new Date('2026-12-03T09:15:30.250Z')).toISOString(), '2027-03-03T09:15:30.250Z');
  assert.equal(passEndsAt(new Date('2026-10-24T23:59:59.000Z')).toISOString(), '2027-01-24T23:59:59.000Z');
});

test('a day past the end of the target month clamps to its last day', () => {
  assert.equal(passEndsAt(new Date('2026-11-30T12:00:00Z')).toISOString(), '2027-02-28T12:00:00.000Z');
  assert.equal(passEndsAt(new Date('2027-11-30T12:00:00Z')).toISOString(), '2028-02-29T12:00:00.000Z', 'leap year');
  assert.equal(passEndsAt(new Date('2027-01-31T00:00:00Z')).toISOString(), '2027-04-30T00:00:00.000Z');
  assert.equal(passEndsAt(new Date('2026-08-31T08:00:00Z')).toISOString(), '2026-11-30T08:00:00.000Z');
});

test('the year rolls over and DST plays no part', () => {
  // 2027-03-28 is the EU spring-forward; UTC arithmetic is unaffected by it.
  assert.equal(passEndsAt(new Date('2026-12-28T01:30:00Z')).toISOString(), '2027-03-28T01:30:00.000Z');
  assert.equal(passEndsAt(new Date('2026-10-25T01:30:00Z')).toISOString(), '2027-01-25T01:30:00.000Z');
});

// ---------------------------------------------------------------------------
// 2. Stacking
// ---------------------------------------------------------------------------

test('with nothing live, a new pass starts now and is active', () => {
  const paidAt = new Date('2026-12-10T10:00:00Z');
  const window = planPassWindow([], paidAt);
  assert.equal(window.status, 'active');
  assert.equal(window.startsAt.toISOString(), paidAt.toISOString());
  assert.equal(window.endsAt.toISOString(), '2027-03-10T10:00:00.000Z');
});

test('a pass bought during a pass starts at its end date, so no day is lost', () => {
  const live = [pass({ id: 'a', starts_at: iso('2026-12-10T10:00:00Z'), ends_at: iso('2027-03-10T10:00:00Z') })];
  const window = planPassWindow(live, new Date('2027-02-01T00:00:00Z'));
  assert.equal(window.status, 'scheduled');
  assert.equal(window.startsAt.toISOString(), '2027-03-10T10:00:00.000Z');
  assert.equal(window.endsAt.toISOString(), '2027-06-10T10:00:00.000Z');
});

test('an ended pass still marked active does not push a new pass into the future', () => {
  const live = [pass({ id: 'a', starts_at: iso('2026-09-10T10:00:00Z'), ends_at: iso('2026-12-10T10:00:00Z') })];
  const window = planPassWindow(live, new Date('2026-12-11T00:00:00Z'));
  assert.equal(window.status, 'active');
  assert.equal(window.startsAt.toISOString(), '2026-12-11T00:00:00.000Z');
});

test('one queued pass at most', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const current = pass({ id: 'a', starts_at: iso('2026-12-10T10:00:00Z'), ends_at: iso('2027-03-10T10:00:00Z') });
  const queued = pass({ id: 'b', status: 'scheduled', starts_at: current.ends_at, ends_at: iso('2027-06-10T10:00:00Z') });
  assert.equal(canQueueAnotherPass(null), true);
  assert.equal(canQueueAnotherPass(activeFromLive([current], now)), true);
  const stacked = activeFromLive([current, queued], now);
  assert.ok(stacked);
  assert.equal(stacked.queued?.id, 'b');
  assert.equal(stacked.coveredUntil.toISOString(), '2027-06-10T10:00:00.000Z');
  assert.equal(canQueueAnotherPass(stacked), false);
});

test('a stacked pass whose start has come covers before the sweep flips it', () => {
  const now = new Date('2027-03-11T00:00:00Z');
  const ended = pass({ id: 'a', starts_at: iso('2026-12-10T10:00:00Z'), ends_at: iso('2027-03-10T10:00:00Z') });
  const queued = pass({ id: 'b', status: 'scheduled', starts_at: ended.ends_at, ends_at: iso('2027-06-10T10:00:00Z') });
  const active = activeFromLive([ended, queued].filter((p) => new Date(p.ends_at) > now), now);
  assert.equal(active?.current.id, 'b');
  assert.equal(active?.queued, null);
});

// ---------------------------------------------------------------------------
// 3. Subscriptions, eligibility, effective plan
// ---------------------------------------------------------------------------

test('entitled subscriptions are the four statuses the webhook keeps, or a paid plan with no status', () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    assert.equal(hasEntitledSubscription({ plan: 'personal', subscription_status: status }), true, status);
  }
  assert.equal(hasEntitledSubscription({ plan: 'solo', subscription_status: null }), true, 'comped or seeded');
  for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(hasEntitledSubscription({ plan: 'personal', subscription_status: status }), false, status);
  }
  assert.equal(hasEntitledSubscription({ plan: 'free', subscription_status: 'active' }), false);
  assert.equal(hasEntitledSubscription(null), false);
});

test('a subscriber cannot buy a pass; a pass holder can stack exactly one', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const current = pass({ id: 'a', starts_at: iso('2026-12-10T10:00:00Z'), ends_at: iso('2027-03-10T10:00:00Z') });
  const queued = pass({ id: 'b', status: 'scheduled', starts_at: current.ends_at, ends_at: iso('2027-06-10T10:00:00Z') });

  assert.deepEqual(
    passEligibility({ billing: { plan: 'personal', subscription_status: 'past_due' }, active: null }),
    { eligible: false, reason: 'already_subscribed' },
  );
  assert.deepEqual(passEligibility({ billing: null, active: null }), { eligible: true, stacked: false });
  assert.deepEqual(
    passEligibility({ billing: { plan: 'free', subscription_status: 'canceled' }, active: activeFromLive([current], now) }),
    { eligible: true, stacked: true },
  );
  assert.deepEqual(
    passEligibility({ billing: null, active: activeFromLive([current, queued], now) }),
    { eligible: false, reason: 'pass_already_queued' },
  );
});

test('the effective plan: subscription first, then the pass, then Free', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const active = activeFromLive(
    [pass({ id: 'a', starts_at: iso('2026-12-10T10:00:00Z'), ends_at: iso('2027-03-10T10:00:00Z') })],
    now,
  );
  assert.equal(effectivePlan({ billing: { plan: 'solo', subscription_status: 'active' }, active }), 'solo');
  assert.equal(effectivePlan({ billing: { plan: 'free', subscription_status: 'canceled' }, active }), 'personal');
  assert.equal(effectivePlan({ billing: { plan: 'personal', subscription_status: 'canceled' }, active: null }), 'free');
  assert.equal(effectivePlan({ billing: null, active: null }), 'free');
});

// ---------------------------------------------------------------------------
// 4. The kill switch
// ---------------------------------------------------------------------------

test('PERSONAL_PASS_ENABLED defaults to off and only knows off, holdout and on', () => {
  const before = process.env.PERSONAL_PASS_ENABLED;
  try {
    delete process.env.PERSONAL_PASS_ENABLED;
    assert.equal(personalPassMode(), 'off');
    assert.equal(passCheckoutOpen(), false);
    for (const [raw, expected] of [
      ['on', 'on'], [' ON ', 'on'], ['holdout', 'holdout'], ['true', 'off'], ['1', 'off'], ['', 'off'],
    ] as const) {
      process.env.PERSONAL_PASS_ENABLED = raw;
      assert.equal(personalPassMode(), expected, JSON.stringify(raw));
    }
    assert.equal(passCheckoutOpen('holdout'), true);
    assert.equal(passCheckoutOpen('on'), true);
  } finally {
    if (before === undefined) delete process.env.PERSONAL_PASS_ENABLED;
    else process.env.PERSONAL_PASS_ENABLED = before;
  }
});

// ---------------------------------------------------------------------------
// 5. Reads
// ---------------------------------------------------------------------------

test('getActivePass reads only this user\'s live, covering passes', async () => {
  const db = new FakeSupabase();
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  db.seed('user_passes', [
    pass({ id: 'mine', starts_at: new Date(now.getTime() - day).toISOString(), ends_at: new Date(now.getTime() + 80 * day).toISOString() }),
    pass({ id: 'refunded', status: 'refunded', starts_at: new Date(now.getTime() - day).toISOString(), ends_at: new Date(now.getTime() + 80 * day).toISOString() }),
    pass({ id: 'theirs', user_id: 'someone-else', starts_at: new Date(now.getTime() - day).toISOString(), ends_at: new Date(now.getTime() + 80 * day).toISOString() }),
  ].map((row) => ({ ...row })));
  const active = await getActivePass(asClient(db), USER, { now });
  assert.equal(active?.current.id, 'mine');
  assert.equal(active?.queued, null);
  assert.equal(await getActivePass(asClient(db), 'nobody', { now }), null);
});

test('a missing table is no pass, in strict mode too, so the webhook never breaks before the migration', async () => {
  for (const error of [
    { code: '42P01', message: 'relation "public.user_passes" does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.user_passes' in the schema cache" },
  ]) {
    const db = new FakeSupabase();
    db.failOnce('user_passes', error);
    assert.equal(await getActivePass(asClient(db), USER, { strict: true }), null, error.code);
  }
});

test('any other read error is no pass when tolerant, and a throw when strict', async () => {
  const db = new FakeSupabase();
  db.failOnce('user_passes', { message: 'connection reset' });
  assert.equal(await getActivePass(asClient(db), USER), null);
  db.failOnce('user_passes', { message: 'connection reset' });
  await assert.rejects(getActivePass(asClient(db), USER, { strict: true }), /connection reset/);
});

test('a pass is owed two notices: seven days before its end, and on the day', () => {
  const notices = passNoticesFor({ id: 'p1', user_id: USER, ends_at: '2027-03-10T10:00:00.000Z' });
  assert.deepEqual(
    notices.map((n) => [n.template, n.sendAfter]),
    [
      ['pass_ending_7d', '2027-03-03T10:00:00.000Z'],
      ['pass_ended', '2027-03-10T10:00:00.000Z'],
    ],
  );
});

// ---------------------------------------------------------------------------
// Review fixes: paused subscribers, and the projection race
// ---------------------------------------------------------------------------

test('a paused subscriber cannot buy a pass', () => {
  const paused = { plan: 'free', subscription_status: 'paused', stripe_subscription_id: 'sub_p' };
  assert.equal(isPausedSubscriber(paused), true);
  assert.equal(isPausedSubscriber({ ...paused, stripe_subscription_id: null }), false);
  assert.equal(isPausedSubscriber({ plan: 'free', subscription_status: 'canceled', stripe_subscription_id: 'sub_p' }), false);
  assert.deepEqual(passEligibility({ billing: paused, active: null }), {
    eligible: false,
    reason: 'subscription_paused',
  });
});

test('a pass bought while the projection runs is not overwritten with Free', async () => {
  const db = new FakeSupabase();
  db.seed('workspaces', [{ id: 'w1', owner_id: USER, plan: 'personal', deleted_at: null }]);
  const now = new Date();
  const client = asClient(db);
  let raced = false;
  // The concurrent purchase lands after this projection read "no pass" and
  // before its write: exactly the window the expiry sweep used to lose.
  const racing = {
    ...client,
    from(table: string) {
      if (table === 'workspaces' && !raced) {
        raced = true;
        db.seed('user_passes', [
          {
            ...pass({
              id: 'bought',
              starts_at: new Date(now.getTime() - 1000).toISOString(),
              ends_at: passEndsAt(now).toISOString(),
            }),
          },
        ]);
      }
      return client.from(table as never);
    },
  } as unknown as typeof client;

  const plan = await reprojectUserPlan(racing, USER, 'test', now);

  assert.equal(raced, true);
  assert.equal(plan, 'personal');
  assert.equal(db.table('workspaces')[0].plan, 'personal');
});

test('without a race the projection writes once and returns the plan', async () => {
  const db = new FakeSupabase();
  db.seed('workspaces', [{ id: 'w1', owner_id: USER, plan: 'personal', deleted_at: null }]);
  assert.equal(await reprojectUserPlan(asClient(db), USER, 'test'), 'free');
  assert.equal(db.table('workspaces')[0].plan, 'free');
});

test('monthly opens on the first whole UTC day Stripe can anchor it, across the February clamp', async () => {
  const { passSubscriptionOpensAt, passSubscriptionStart } = await import('./pass.ts');
  const now = new Date('2026-12-10T12:00:00Z');
  const end = new Date('2027-02-28T12:00:00Z');
  // 29 to 31 January + 1 month all clamp to 28 February at the same time of
  // day, so their mornings do not fit; 1 February is the first whole day.
  const opens = passSubscriptionOpensAt(end, 'month', now);
  assert.equal(opens?.toISOString(), '2027-02-01T00:00:00.000Z');
  assert.equal(passSubscriptionStart(end, 'month', new Date('2027-01-30T06:00:00Z')), null);
  for (const hour of [0, 6, 12, 23]) {
    assert.ok(passSubscriptionStart(end, 'month', new Date(Date.UTC(2027, 1, 1, hour))), `1 Feb ${hour}:00`);
  }
  assert.equal(passSubscriptionOpensAt(end, 'month', opens!), null);
  assert.equal(passSubscriptionOpensAt(end, 'year', now), null, 'yearly always fits');
});
