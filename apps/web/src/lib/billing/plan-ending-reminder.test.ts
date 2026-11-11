/**
 * The plan-ending reminder: who gets it, the experiment split, the dry run,
 * the email, the cancellation-confirmation links, the freshness check and
 * "Keep my plan".
 *
 * Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        src/lib/billing/plan-ending-reminder.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PRICES, sec, setPlanChangeTestPrices, subscriptionFixture } from '@/lib/billing/plan-change-fixtures';

setPlanChangeTestPrices();
process.env.CSRF_SECRET = 'ab'.repeat(32);

const reminder = await import('@/lib/billing/plan-ending-reminder');
const { toStoppingSubscription } = await import('@/lib/billing/plan-ending-reminder-store');
const { composeBillingEmail, categoryOf, sendInputForQueueRow } = await import('@/lib/email/billing-lifecycle');
const { checkFreshness } = await import('@/lib/billing/dispatch-freshness');
const { keepPlanQuote, keepPlanUpdate } = await import('@/lib/billing/keep-plan');
const { FREE_ACTION_ALLOWANCE } = await import('@/lib/stripe/plans');

type Sub = import('@/lib/billing/plan-ending-reminder').StoppingSubscription;
type Owner = import('@/lib/billing/plan-ending-reminder').OwnerFacts;
type Row = import('@/lib/billing/plan-ending-reminder').LedgerRow;

const NOW = new Date('2026-11-11T08:15:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

// ── Flag ────────────────────────────────────────────────────────────────────

test('PLAN_ENDING_REMINDER_ENABLED: off by default, unknown values are off', () => {
  assert.equal(reminder.planEndingMode({}), 'off');
  assert.equal(reminder.planEndingMode({ PLAN_ENDING_REMINDER_ENABLED: 'off' }), 'off');
  assert.equal(reminder.planEndingMode({ PLAN_ENDING_REMINDER_ENABLED: 'yes' }), 'off');
  assert.equal(reminder.planEndingMode({ PLAN_ENDING_REMINDER_ENABLED: 'dry_run' }), 'dry_run');
  assert.equal(reminder.planEndingMode({ PLAN_ENDING_REMINDER_ENABLED: ' ON ' }), 'on');
  assert.equal(reminder.planEndingLinksOn({ PLAN_ENDING_REMINDER_ENABLED: 'dry_run' }), false);
  assert.equal(reminder.planEndingLinksOn({ PLAN_ENDING_REMINDER_ENABLED: 'on' }), true);
});

test('links land on the billing page with the action in the query, never the hash', () => {
  assert.equal(
    reminder.planActionUrl('https://mcpemails.com/', 'keep', 'plan_ending_email'),
    'https://mcpemails.com/dashboard/settings?plan_action=keep&src=plan_ending_email',
  );
  assert.equal(reminder.planActionSource('cancel_email'), 'cancel_email');
  assert.equal(reminder.planActionSource('evil'), null);
});

// ── Window and stop date ────────────────────────────────────────────────────

test('stop date: cancel_at wins, else the period end under cancel_at_period_end, else none', () => {
  assert.equal(reminder.stopAtSeconds({ cancelAt: 100, cancelAtPeriodEnd: false, currentPeriodEnd: 200 }), 100);
  assert.equal(reminder.stopAtSeconds({ cancelAt: null, cancelAtPeriodEnd: true, currentPeriodEnd: 200 }), 200);
  assert.equal(reminder.stopAtSeconds({ cancelAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: 200 }), null);
});

test('the window is whole days 4, 5 and 6', () => {
  assert.equal(reminder.inReminderWindow(NOW_S + 4 * DAY - 1, NOW_S), false);
  assert.equal(reminder.inReminderWindow(NOW_S + 4 * DAY, NOW_S), true);
  assert.equal(reminder.inReminderWindow(NOW_S + 6 * DAY + 23 * 3600, NOW_S), true);
  assert.equal(reminder.inReminderWindow(NOW_S + 7 * DAY, NOW_S), false);
});

test('subject id: 32 lowercase hex, stable per subscription, about half in each arm', () => {
  const a = reminder.subjectIdForSubscription('sub_1');
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.equal(a, reminder.subjectIdForSubscription('sub_1'));
  assert.notEqual(a, reminder.subjectIdForSubscription('sub_2'));
  let n = 0;
  for (let i = 0; i < 1000; i++) if (reminder.hashedVariant(reminder.subjectIdForSubscription(`sub_${i}`)) === 'reminder') n++;
  assert.ok(n > 430 && n < 570, `split ${n}/1000`);
});

test('toStoppingSubscription reads both stop shapes and the pause state from Stripe', () => {
  const end = '2026-11-16T12:00:00Z';
  const portal = toStoppingSubscription(
    subscriptionFixture({ periodEnd: end, cancelAt: sec(end) }) as never,
    NOW,
  );
  assert.equal(reminder.stopAtSeconds(portal), sec(end));
  assert.equal(portal.planId, 'solo');
  assert.equal(portal.interval, 'month');
  assert.equal(portal.pauseEligible, true);
  const api = toStoppingSubscription(subscriptionFixture({ periodEnd: end, cancelAtPeriodEnd: true }) as never, NOW);
  assert.equal(reminder.stopAtSeconds(api), sec(end));
  const paused = toStoppingSubscription(
    subscriptionFixture({ periodEnd: end, cancelAt: sec(end), pauseResumesAt: sec('2027-01-16T12:00:00Z') }) as never,
    NOW,
  );
  assert.equal(paused.paused, true);
});

// ── The run ─────────────────────────────────────────────────────────────────

function sub(overrides: Partial<Sub> = {}): Sub {
  return {
    id: 'sub_a',
    customerId: 'cus_a',
    status: 'active',
    cancelAtPeriodEnd: false,
    cancelAt: NOW_S + 5 * DAY,
    currentPeriodEnd: NOW_S + 5 * DAY,
    paused: false,
    metadataUserId: 'user_a',
    planId: 'personal',
    interval: 'month',
    pauseEligible: true,
    ...overrides,
  };
}

function owner(overrides: Partial<Owner> = {}): Owner {
  return {
    userId: 'user_a',
    email: 'owner@example.com',
    workspaceId: 'ws_a',
    internal: false,
    deleted: false,
    grandfathered: false,
    freeCapExempt: false,
    pauseOffered: true,
    ...overrides,
  };
}

class FakeStore {
  queued: Row[] = [];
  holdouts: Row[] = [];
  funnels: Array<{ workspaceId: string; stage: string; planId: string }> = [];
  assigned: string[] = [];
  handled = new Set<string>();
  subs: Sub[];
  owners: Record<string, Owner | null>;
  opts: { recentUse?: boolean; arm?: 'holdout' | 'reminder' | null; recipient?: string | null; failOwnerFor?: string };
  constructor(
    subs: Sub[],
    owners: Record<string, Owner | null> = {},
    opts: { recentUse?: boolean; arm?: 'holdout' | 'reminder' | null; recipient?: string | null; failOwnerFor?: string } = {},
  ) {
    this.subs = subs;
    this.owners = owners;
    this.opts = opts;
  }
  async *listSubscriptions() {
    for (const s of this.subs) yield s;
  }
  async owner(s: Sub) {
    if (this.opts.failOwnerFor === s.id) throw new Error('auth read failed');
    return s.id in this.owners ? this.owners[s.id] : owner();
  }
  async recipient() {
    return this.opts.recipient === undefined ? 'owner@example.com' : this.opts.recipient;
  }
  async hadSuccessfulCallSince() {
    return this.opts.recentUse ?? true;
  }
  async alreadyHandled(_c: string, scopeKey: string) {
    return this.handled.has(scopeKey);
  }
  async assign(subjectId: string) {
    this.assigned.push(subjectId);
    return this.opts.arm === undefined ? 'reminder' : this.opts.arm;
  }
  async queueReminder(row: Row) {
    if (this.handled.has(row.scopeKey)) return false;
    this.handled.add(row.scopeKey);
    this.queued.push(row);
    return true;
  }
  async recordHoldout(row: Row) {
    if (this.handled.has(row.scopeKey)) return false;
    this.handled.add(row.scopeKey);
    this.holdouts.push(row);
    return true;
  }
  async funnel(workspaceId: string, stage: string, planId: string) {
    this.funnels.push({ workspaceId, stage, planId });
  }
}

test('reminder arm: one queued row per subscription and stop date, with the facts the email needs', async () => {
  const store = new FakeStore([sub()]);
  const first = await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
  assert.equal(first.queued, 1);
  assert.equal(store.queued[0].scopeKey, `sub_a:${NOW_S + 5 * DAY}`);
  assert.deepEqual(store.queued[0].payload, {
    planId: 'personal',
    interval: 'month',
    periodEnd: new Date((NOW_S + 5 * DAY) * 1000).toISOString(),
    grandfathered: false,
    freeActionCapApplies: true,
    pauseOffered: true,
  });
  assert.equal(store.funnels.length, 0, 'the sent event is written by the dispatcher on send');

  const again = await reminder.runPlanEndingReminder({ store, mode: 'on', now: new Date(NOW.getTime() + DAY * 1000) });
  assert.equal(again.queued, 0);
  assert.equal(again.skipped.already_handled, 1);
  assert.equal(store.queued.length, 1, 'tomorrow, still in the window: nothing new');
});

test('holdout arm: no email, one ledger row and one funnel event', async () => {
  const store = new FakeStore([sub({ planId: 'solo' })], {}, { arm: 'holdout' });
  const report = await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
  assert.equal(report.holdout, 1);
  assert.equal(store.queued.length, 0);
  assert.equal(store.holdouts.length, 1);
  assert.deepEqual(store.funnels, [{ workspaceId: 'ws_a', stage: 'plan_ending_reminder_holdout', planId: 'solo' }]);
  await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
  assert.equal(store.funnels.length, 1, 'once per subscription and stop date');
});

test('a new stop date after a keep-then-cancel is a new reminder', async () => {
  const store = new FakeStore([sub()]);
  await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
  store.subs = [sub({ cancelAt: NOW_S + 6 * DAY })];
  const report = await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
  assert.equal(report.queued, 1);
});

test('dry run: reads everything, assigns nobody, writes nothing', async () => {
  const store = new FakeStore([sub()]);
  const report = await reminder.runPlanEndingReminder({ store, mode: 'dry_run', now: NOW });
  assert.equal(store.assigned.length, 0);
  assert.equal(store.queued.length + store.holdouts.length + store.funnels.length, 0);
  assert.equal(report.entries.length, 1);
  assert.match(report.entries[0].outcome, /^would_(queue|hold_out)$/);
});

test('skips: not scheduled, outside the window, paused, ended, internal, deleted, no recent use, no recipient', async () => {
  const cases: Array<[string, FakeStore]> = [
    ['not_scheduled', new FakeStore([sub({ cancelAt: null })])],
    ['outside_window', new FakeStore([sub({ cancelAt: NOW_S + 2 * DAY })])],
    ['outside_window', new FakeStore([sub({ cancelAt: NOW_S + 20 * DAY })])],
    ['paused', new FakeStore([sub({ paused: true })])],
    ['not_active', new FakeStore([sub({ status: 'past_due' })])],
    ['no_plan', new FakeStore([sub({ planId: null })])],
    ['internal', new FakeStore([sub()], { sub_a: owner({ internal: true }) })],
    ['account_deleted', new FakeStore([sub()], { sub_a: owner({ deleted: true }) })],
    ['no_owner', new FakeStore([sub()], { sub_a: null })],
    ['no_workspace', new FakeStore([sub()], { sub_a: owner({ workspaceId: null }) })],
    ['no_recent_use', new FakeStore([sub()], {}, { recentUse: false })],
    ['no_recipient', new FakeStore([sub()], {}, { recipient: null })],
    ['experiment_not_running', new FakeStore([sub()], {}, { arm: null })],
  ];
  for (const [reason, store] of cases) {
    const report = await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
    assert.equal(report.queued + report.holdout, 0, reason);
    assert.equal(report.skipped[reason as keyof typeof report.skipped], 1, reason);
    assert.equal(store.queued.length + store.holdouts.length + store.funnels.length, 0, reason);
  }
});

test('one failing subscription is counted and the rest still run', async () => {
  const store = new FakeStore([sub({ id: 'sub_bad', customerId: 'cus_b' }), sub()], {}, { failOwnerFor: 'sub_bad' });
  const report = await reminder.runPlanEndingReminder({ store, mode: 'on', now: NOW });
  assert.equal(report.skipped.error, 1);
  assert.equal(report.queued, 1);
});

test('payload: no allowance line for cap-exempt or grandfathered owners, no pause for annual plans', () => {
  const stopAt = NOW_S + 5 * DAY;
  assert.equal(reminder.reminderPayload(sub(), owner({ freeCapExempt: true }), stopAt).freeActionCapApplies, false);
  assert.equal(reminder.reminderPayload(sub(), owner({ grandfathered: true }), stopAt).freeActionCapApplies, false);
  assert.equal(reminder.reminderPayload(sub({ pauseEligible: false }), owner(), stopAt).pauseOffered, false);
  assert.equal(reminder.reminderPayload(sub(), owner({ pauseOffered: false }), stopAt).pauseOffered, false);
});

// ── The email ───────────────────────────────────────────────────────────────

const END_ISO = '2026-11-16T12:00:00.000Z';
const KEEP = 'https://mcpemails.com/dashboard/settings?plan_action=keep&src=plan_ending_email';
const PAUSE = 'https://mcpemails.com/dashboard/settings?plan_action=pause&src=plan_ending_email';

function planEnding(overrides: Record<string, unknown> = {}) {
  const email = composeBillingEmail('plan_ending_5d', {
    planId: 'solo',
    interval: 'month',
    periodEnd: END_ISO,
    grandfathered: false,
    freeActionCapApplies: true,
    pauseOffered: true,
    ...overrides,
  });
  assert.ok(email);
  return email;
}

test('plan_ending_5d: transactional, plan name, end date, Free, nothing deleted, keep and pause links', () => {
  assert.equal(categoryOf('plan_ending_5d'), 'transactional');
  const email = planEnding();
  assert.equal(email.subject, 'Your MCPEmails Pro plan ends on 16 November 2026');
  assert.equal(email.unsubscribeUrl, undefined);
  assert.match(email.body, /^Your Pro plan ends on 16 November 2026, as you scheduled\./);
  assert.match(email.body, /Your account goes back to Free/);
  assert.ok(email.body.includes(`Free includes ${FREE_ACTION_ALLOWANCE} email actions a month.`));
  assert.match(email.body, /Nothing is deleted either way\./);
  assert.ok(email.body.includes(`Keep my plan: ${KEEP}`));
  assert.ok(email.body.includes(`Pause instead: ${PAUSE}`));
  assert.ok(email.htmlBody.includes(`href="${KEEP.replace('&', '&amp;')}"`));
  assert.ok(email.htmlBody.includes(`href="${PAUSE.replace('&', '&amp;')}"`));
  assert.match(email.body, /If ending it is what you want, there is nothing to do\./);
});

test('plan_ending_5d: no price, no discount, no slug, no em dash, no refund window', () => {
  const email = planEnding({ amountCents: 1500, currency: 'usd' });
  for (const text of [email.subject, email.body, email.htmlBody]) {
    assert.ok(!/\$|USD|discount|% off|coupon/i.test(text), 'no price talk');
    assert.ok(!/\bsolo\b/.test(text), 'no slug');
    assert.ok(!text.includes('—'), 'no em dash');
    assert.ok(!/30 days|refund/i.test(text));
  }
});

test('plan_ending_5d: the allowance and the pause link only when the payload allows them', () => {
  const exempt = planEnding({ freeActionCapApplies: false });
  assert.ok(!/email actions a month/.test(exempt.body));
  const annual = planEnding({ pauseOffered: false });
  assert.ok(!annual.body.includes('plan_action=pause'));
  assert.ok(!annual.htmlBody.includes('plan_action=pause'));
  assert.ok(annual.body.includes(KEEP));
  const grandfathered = planEnding({ grandfathered: true, freeActionCapApplies: false });
  assert.ok(!/instead of/.test(grandfathered.body), 'a grandfathered owner keeps their inboxes');
});

test('plan_ending_5d without an end date composes to nothing', () => {
  assert.equal(composeBillingEmail('plan_ending_5d', { planId: 'solo', periodEnd: null }), null);
});

// ── Cancellation confirmation links ─────────────────────────────────────────

const SUB = 'sub_1TestCancel';
const PERIOD_END_S = 1_793_404_800; // 2026-10-31T00:00:00Z

function cancelEmail(overrides: Record<string, unknown> = {}) {
  const row = {
    stripe_customer_id: 'cus_TestCancel',
    recipient: 'customer@example.com',
    template: 'cancel_ask' as const,
    scope_key: `${SUB}:${PERIOD_END_S}`,
    payload: { planId: 'solo' as const, amountCents: 1500, currency: 'usd', periodEnd: new Date(PERIOD_END_S * 1000).toISOString(), ...overrides },
  };
  const email = composeBillingEmail('cancel_ask', sendInputForQueueRow(row).payload);
  assert.ok(email);
  return email;
}

const CANCEL_KEEP = 'https://mcpemails.com/dashboard/settings?plan_action=keep&src=cancel_email';
const CANCEL_PAUSE = 'https://mcpemails.com/dashboard/settings?plan_action=pause&src=cancel_email';

test('cancel confirmation: no keep link and the old pause link while the flag is off or dry_run', () => {
  for (const value of [undefined, 'off', 'dry_run']) {
    withEnv('PLAN_ENDING_REMINDER_ENABLED', value, () =>
      withEnv('BILLING_PAUSE_ENABLED', 'on', () => {
        const email = cancelEmail();
        assert.ok(!email.body.includes('plan_action='), String(value));
        assert.ok(email.body.includes('/dashboard/settings?src=cancel_email#billing'), String(value));
      }),
    );
  }
});

test('cancel confirmation with the flag on: keep link under the facts, pause deep link, legal lines unchanged', () => {
  const before = withEnv('BILLING_PAUSE_ENABLED', 'on', () => cancelEmail());
  withEnv('PLAN_ENDING_REMINDER_ENABLED', 'on', () =>
    withEnv('BILLING_PAUSE_ENABLED', 'on', () => {
      const email = cancelEmail();
      const lines = email.body.split('\n');
      const keepAt = lines.indexOf(CANCEL_KEEP);
      assert.ok(keepAt > lines.findIndex((l) => l.startsWith('Nothing is deleted')), 'below the facts');
      assert.ok(keepAt < lines.findIndex((l) => /withdraw/.test(l)), 'above the withdrawal line');
      assert.match(lines[keepAt - 1], /^If you change your mind before 31 October 2026, you can keep your plan with one click from your billing page:$/);
      assert.ok(email.body.includes(CANCEL_PAUSE));
      assert.ok(email.htmlBody.includes(`href="${CANCEL_KEEP.replace('&', '&amp;')}"`));
      assert.equal((email.body.match(/\?(?!plan_action|t=|src=)/g) ?? []).length, (before.body.match(/\?(?!plan_action|t=|src=)/g) ?? []).length, 'still exactly the one question');
      // Every line of the original survives, in order, apart from the pause link itself.
      const kept = before.body.split('\n').filter((l) => !l.includes('src=cancel_email'));
      let i = 0;
      for (const line of lines) if (line === kept[i]) i++;
      assert.equal(i, kept.length, 'the confirmation, withdrawal and reason lines are unchanged');
    }),
  );
});

// ── Freshness ───────────────────────────────────────────────────────────────

function stripeWith(subscription: Record<string, unknown>) {
  return {
    invoices: { retrieve: async () => ({}) },
    paymentMethods: { retrieve: async () => ({}) },
    subscriptions: { retrieve: async () => subscription },
  };
}

test('freshness: sent only while the plan still ends on that date', async () => {
  const stop = sec('2026-11-16T12:00:00Z');
  const row = { id: 1, template: 'plan_ending_5d', scope_key: `sub_q:${stop}` };
  assert.deepEqual(await checkFreshness(stripeWith({ status: 'active', cancel_at: stop }), row), { send: true });
  assert.deepEqual(
    await checkFreshness(stripeWith({ status: 'active', cancel_at: null, cancel_at_period_end: true, items: { data: [{ current_period_end: stop }] } }), row),
    { send: true },
  );
  assert.deepEqual(await checkFreshness(stripeWith({ status: 'active', cancel_at: null, cancel_at_period_end: false }), row), { send: false, reason: 'subscription_reactivated' });
  assert.deepEqual(await checkFreshness(stripeWith({ status: 'active', cancel_at: stop + DAY }), row), { send: false, reason: 'no_longer_due' });
  assert.deepEqual(await checkFreshness(stripeWith({ status: 'active', cancel_at: stop, pause_collection: { resumes_at: stop + 30 * DAY } }), row), { send: false, reason: 'no_longer_due' });
  assert.deepEqual(await checkFreshness(stripeWith({ status: 'canceled', cancel_at: stop }), row), { send: false, reason: 'no_longer_due' });
});

// ── Keep my plan ────────────────────────────────────────────────────────────

test('keep: clears cancel_at when that is the shape, the boolean otherwise', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  const portal = subscriptionFixture({ periodEnd: '2026-11-16T12:00:00Z', cancelAt: sec('2026-11-16T12:00:00Z') });
  assert.deepEqual(keepPlanQuote(portal as never, now), { cancelScheduled: true, endsAt: sec('2026-11-16T12:00:00Z'), canKeep: true, refusal: null });
  assert.deepEqual(keepPlanUpdate(portal as never, now), { cancel_at: '' });
  const api = subscriptionFixture({ periodEnd: '2026-11-16T12:00:00Z', cancelAtPeriodEnd: true });
  assert.deepEqual(keepPlanUpdate(api as never, now), { cancel_at_period_end: false });
  assert.equal(keepPlanQuote(api as never, now).endsAt, sec('2026-11-16T12:00:00Z'));
});

test('keep: refused when nothing is scheduled, when paused, when not active, or after the end', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  assert.equal(keepPlanQuote(subscriptionFixture() as never, now).refusal, 'not_scheduled');
  const paused = subscriptionFixture({ periodEnd: '2026-11-16T12:00:00Z', cancelAt: sec('2026-12-16T12:00:00Z'), pauseResumesAt: sec('2026-12-16T12:00:00Z') });
  assert.equal(keepPlanQuote(paused as never, now).refusal, 'paused');
  const pastDue = subscriptionFixture({ status: 'past_due', cancelAt: sec('2026-11-16T12:00:00Z') });
  assert.equal(keepPlanQuote(pastDue as never, now).refusal, 'not_active');
  const ended = subscriptionFixture({ cancelAt: sec('2026-11-10T12:00:00Z') });
  assert.equal(keepPlanQuote(ended as never, now).refusal, 'already_ended');
  assert.equal(keepPlanUpdate(ended as never, now), null);
  void PRICES;
});
