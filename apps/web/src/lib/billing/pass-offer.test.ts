// ---------------------------------------------------------------------------
// The 3-month Personal pass surfaces: who is offered it, which arm, the
// 72-hour cap rule, the holder's Billing state, the renewal rule, the notice
// freshness, the two emails, the paywall step 3 line and the board line.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/billing/pass-offer.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import type { ExperimentRecord } from '@/lib/experiments';
import type { ExperimentStore } from '@/lib/experiments';
import {
  CAP_DWELL_MS,
  capBannerDue,
  evaluatePassOffer,
  loadPassBillingState,
  passBillingState,
  passCheckoutHref,
  passExperimentSubject,
  passOfferEligible,
  paywallEmailPassLine,
  recordPassOfferShownOnce,
  resolvePassArm,
} from './pass-offer.ts';
import { isPassRenewal, passNoticeFreshness, passNoticeSink } from './pass-notices.ts';
import type { ActivePass, PassRow } from './pass.ts';
import { composeBillingEmail } from '@/lib/email/billing-lifecycle';
import { composePaywallFollowup, passSentence } from '@/lib/email/paywall-followup-templates';
import { passSummaryLine, summarisePasses } from '@/lib/analytics/pass-summary';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-12-10T12:00:00Z');
const WS = '11111111-2222-4333-8444-555555555555';
const OWNER = '00000000-0000-4000-8000-0000000000aa';

function withMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PERSONAL_PASS_ENABLED;
  if (mode === undefined) delete process.env.PERSONAL_PASS_ENABLED;
  else process.env.PERSONAL_PASS_ENABLED = mode;
  return fn().finally(() => {
    if (before === undefined) delete process.env.PERSONAL_PASS_ENABLED;
    else process.env.PERSONAL_PASS_ENABLED = before;
  });
}

function experiment(status: ExperimentRecord['status'] = 'running'): ExperimentRecord {
  return {
    key: 'personal_pass_3m',
    name: 'pass',
    description: null,
    status,
    variants: [
      { id: 'holdout', label: 'holdout', weight: 50 },
      { id: 'pass', label: 'pass', weight: 50 },
    ],
    winner_variant_id: null,
    retention_goal: 'mailbox_activity',
    retention_window_days: 7,
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:00:00Z',
    started_at: null,
    concluded_at: null,
  };
}

/** A store that pins the stored variant, and counts assignments. */
function store(stored: 'holdout' | 'pass', record: ExperimentRecord | null = experiment()) {
  const calls: string[] = [];
  const s: ExperimentStore = {
    async getExperiment() {
      return record;
    },
    async assign(_key, subjectId) {
      calls.push(subjectId);
      return stored;
    },
  };
  return { store: s, calls };
}

function pass(id: string, startsAt: Date, endsAt: Date, status: PassRow['status'] = 'active'): PassRow {
  return {
    id,
    user_id: OWNER,
    product: 'personal_pass_3m',
    plan: 'personal',
    stripe_checkout_session_id: `cs_${id}`,
    stripe_payment_intent_id: `pi_${id}`,
    amount_minor: 2900,
    currency: 'usd',
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    status,
    reminder_queued_at: null,
    expired_at: null,
    refunded_at: null,
  };
}

// ---------------------------------------------------------------------------
// 72-hour rule
// ---------------------------------------------------------------------------

test('cap banner: due only when at a cap now AND the first hit is 72 h old', () => {
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
  const none = { firstHitAt: null, atCapNow: false };
  assert.equal(capBannerDue({ now: NOW, actions: { firstHitAt: at(CAP_DWELL_MS), atCapNow: true }, inboxes: none }).cap, 'actions');
  assert.equal(capBannerDue({ now: NOW, actions: { firstHitAt: at(CAP_DWELL_MS - 1000), atCapNow: true }, inboxes: none }).due, false);
  // Hit long ago but no longer at the cap (the period reset, or an inbox removed).
  assert.equal(capBannerDue({ now: NOW, actions: { firstHitAt: at(10 * DAY), atCapNow: false }, inboxes: none }).due, false);
  assert.equal(capBannerDue({ now: NOW, actions: none, inboxes: { firstHitAt: at(4 * DAY), atCapNow: true } }).cap, 'inboxes');
  // At the cap, but never recorded hitting it: not due.
  assert.equal(capBannerDue({ now: NOW, actions: { firstHitAt: null, atCapNow: true }, inboxes: none }).due, false);
  // A future hit (clock skew) or garbage is never due.
  assert.equal(capBannerDue({ now: NOW, actions: { firstHitAt: at(-DAY), atCapNow: true }, inboxes: none }).due, false);
  assert.equal(capBannerDue({ now: NOW, actions: { firstHitAt: 'nope', atCapNow: true }, inboxes: none }).due, false);
});

// ---------------------------------------------------------------------------
// Eligibility and arms
// ---------------------------------------------------------------------------

test('the experiment subject is the workspace uuid without dashes', () => {
  assert.equal(passExperimentSubject(WS), '11111111222243338444555555555555');
  assert.equal(passExperimentSubject('not-a-uuid'), null);
  assert.equal(passExperimentSubject(null), null);
});

test('only an owned Free workspace with no subscription, comp or pass is eligible', () => {
  const base = { isOwner: true, workspacePlan: 'free', billing: null, compedGrant: false, active: null };
  assert.equal(passOfferEligible(base), true);
  assert.equal(passOfferEligible({ ...base, isOwner: false }), false);
  assert.equal(passOfferEligible({ ...base, workspacePlan: 'personal' }), false);
  assert.equal(passOfferEligible({ ...base, compedGrant: true }), false);
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    assert.equal(passOfferEligible({ ...base, billing: { plan: 'personal', subscription_status: status } }), false);
  }
  // A cancelled subscription is a Free account again.
  assert.equal(passOfferEligible({ ...base, billing: { plan: 'free', subscription_status: 'canceled' } }), true);
  const active: ActivePass = { current: pass('p1', NOW, new Date(NOW.getTime() + DAY)), queued: null, coveredUntil: new Date(NOW.getTime() + DAY) };
  assert.equal(passOfferEligible({ ...base, active }), false);
});

test('off and on never touch the experiment; holdout assigns and follows the stored arm', async () => {
  const off = store('pass');
  assert.equal(await resolvePassArm(WS, 'off', off.store), null);
  const on = store('holdout');
  assert.equal(await resolvePassArm(WS, 'on', on.store), 'pass');
  assert.equal(off.calls.length + on.calls.length, 0);

  const treated = store('pass');
  assert.equal(await resolvePassArm(WS, 'holdout', treated.store), 'pass');
  assert.deepEqual(treated.calls, ['11111111222243338444555555555555']);
  const held = store('holdout');
  assert.equal(await resolvePassArm(WS, 'holdout', held.store), 'holdout');
  // A draft or missing experiment serves the control and records nothing.
  const draft = store('pass', experiment('draft'));
  assert.equal(await resolvePassArm(WS, 'holdout', draft.store), 'holdout');
  assert.equal(draft.calls.length, 0);
  const missing = store('pass', null);
  assert.equal(await resolvePassArm(WS, 'holdout', missing.store), 'holdout');
});

function seedWorkspace(db: FakeSupabase, patch: Record<string, unknown> = {}) {
  db.seed('workspaces', [{ id: WS, owner_id: OWNER, plan: 'free', deleted_at: null, ...patch }]);
}

test('checkout_return: shown to the pass arm only, and pass_offer_shown once a day', async () => {
  await withMode('holdout', async () => {
    const db = new FakeSupabase();
    seedWorkspace(db);
    const holdout = await evaluatePassOffer({
      userId: OWNER, workspaceId: WS, surface: 'checkout_return', now: NOW, db: asClient(db), store: store('holdout').store,
    });
    assert.equal(holdout.show, false);
    assert.equal(db.table('product_funnel_events').length, 0);

    const treated = await evaluatePassOffer({
      userId: OWNER, workspaceId: WS, surface: 'checkout_return', now: NOW, db: asClient(db), store: store('pass').store,
    });
    assert.equal(treated.show, true);
    assert.equal(treated.arm, 'pass');
    assert.equal(treated.endsAt, '2027-03-10T12:00:00.000Z');
    const shown = db.table('product_funnel_events');
    assert.equal(shown.length, 1);
    assert.equal(shown[0].stage, 'pass_offer_shown');
    assert.equal(shown[0].category, 'checkout_return');
  });
});

test('nobody else sees it: someone else, a subscriber, the switch off', async () => {
  const db = new FakeSupabase();
  seedWorkspace(db);
  const ask = (userId = OWNER) =>
    evaluatePassOffer({ userId, workspaceId: WS, surface: 'checkout_return', now: NOW, db: asClient(db), store: store('pass').store });
  await withMode('off', async () => assert.equal((await ask()).show, false));
  await withMode(undefined, async () => assert.equal((await ask()).show, false));
  await withMode('on', async () => {
    assert.equal((await ask('00000000-0000-4000-8000-0000000000bb')).show, false);
    assert.equal((await ask()).show, true);
    db.seed('user_billing', [{ user_id: OWNER, plan: 'personal', subscription_status: 'active' }]);
    assert.equal((await ask()).show, false);
  });
});

test('pass_offer_shown is deduplicated per workspace, surface and UTC day', async () => {
  const db = new FakeSupabase();
  db.seed('product_funnel_events', [
    { workspace_id: WS, stage: 'pass_offer_shown', category: 'cap_banner', occurred_at: '2026-12-10T01:00:00Z' },
  ]);
  assert.equal(await recordPassOfferShownOnce(asClient(db), WS, 'cap_banner', NOW), false);
  assert.equal(await recordPassOfferShownOnce(asClient(db), WS, 'checkout_return', NOW), true);
  assert.equal(
    await recordPassOfferShownOnce(asClient(db), WS, 'cap_banner', new Date('2026-12-11T00:30:00Z')),
    true,
  );
});

test('the paywall step 3 line: pass arm only, an absolute pass link', async () => {
  await withMode('holdout', async () => {
    const db = new FakeSupabase();
    seedWorkspace(db);
    const line = await paywallEmailPassLine(WS, NOW, { db: asClient(db), store: store('pass').store, base: 'https://mcpemails.com' });
    assert.ok(line);
    assert.equal(line.endsOn, '10 March 2027');
    assert.equal(
      line.url,
      'https://mcpemails.com/api/stripe/checkout/start?product=personal_pass_3m&arm=pass&from=paywall_email_3',
    );
    assert.equal(await paywallEmailPassLine(WS, NOW, { db: asClient(db), store: store('holdout').store }), null);
  });
  await withMode('off', async () => {
    const db = new FakeSupabase();
    seedWorkspace(db);
    assert.equal(await paywallEmailPassLine(WS, NOW, { db: asClient(db), store: store('pass').store }), null);
  });
});

test('step 3 carries the pass sentence after the subscription options, and only when given', () => {
  const plain = composePaywallFollowup({ step: 3, paywallKind: 'action_cap', unsubscribeToken: 'tok' });
  const withPass = composePaywallFollowup({
    step: 3,
    paywallKind: 'action_cap',
    unsubscribeToken: 'tok',
    pass: { endsOn: '10 March 2027', url: 'https://mcpemails.com/x' },
  });
  assert.ok(plain && withPass);
  assert.equal(plain.text.includes('3 months, paid once'), false);
  const sentence = passSentence({ endsOn: '10 March 2027', url: '' });
  assert.match(sentence, /Personal, 3 months, paid once, \$29\. Nothing renews\./);
  assert.ok(withPass.text.includes(sentence));
  // Below the plans, and the call to action is still the plan comparison.
  assert.ok(withPass.text.indexOf(sentence) > withPass.text.indexOf('a month:'));
  assert.equal(withPass.subject, plain.subject);
  for (const word of [/trial/i, /deal/i, /save/i, /—/]) assert.equal(word.test(sentence), false);
  // Steps 1 and 2 ignore it.
  const step1 = composePaywallFollowup({ step: 1, paywallKind: 'action_cap', unsubscribeToken: 'tok', pass: { endsOn: 'x', url: 'y' } });
  assert.equal(step1?.text.includes('paid once'), false);
});

test('passCheckoutHref carries the product, arm and surface', () => {
  assert.equal(
    passCheckoutHref({ surface: 'cap_banner', arm: 'pass', locale: 'de' }),
    '/api/stripe/checkout/start?product=personal_pass_3m&lang=de&arm=pass&from=cap_banner',
  );
});

// ---------------------------------------------------------------------------
// Holder state on Billing
// ---------------------------------------------------------------------------

test('Billing state: the anchored first charge is the pass end, the queued pass and the last week', () => {
  const ends = new Date(NOW.getTime() + 20 * DAY);
  const active: ActivePass = { current: pass('p1', new Date(NOW.getTime() - 70 * DAY), ends), queued: null, coveredUntil: ends };
  const state = passBillingState(active, { now: NOW, checkoutOpen: true });
  assert.equal(state.firstCharge.month, ends.toISOString());
  assert.equal(state.firstCharge.year, ends.toISOString());
  assert.equal(state.inLastWeek, false);
  assert.equal(state.canAddPass, true);
  assert.equal(state.nextPassEndsAt, new Date(Date.UTC(2027, 2, 30, 12)).toISOString());

  // A pass ending beyond the first monthly period: Stripe falls back to
  // trial_end, and the first charge is STILL the pass end.
  const far = new Date(NOW.getTime() + 80 * DAY);
  const long: ActivePass = { current: pass('p2', NOW, far), queued: null, coveredUntil: far };
  assert.equal(passBillingState(long, { now: NOW }).firstCharge.month, far.toISOString());

  // Within the hour: charged today.
  const soon = new Date(NOW.getTime() + 30 * 60 * 1000);
  const ending: ActivePass = { current: pass('p3', NOW, soon), queued: null, coveredUntil: soon };
  const endingState = passBillingState(ending, { now: NOW });
  assert.equal(endingState.firstCharge.month, null);
  assert.equal(endingState.inLastWeek, true);

  // One queued pass already: no third, and the cover runs to the queued end.
  const queuedEnd = new Date(ends.getTime() + 90 * DAY);
  const stacked: ActivePass = { current: active.current, queued: pass('p4', ends, queuedEnd, 'scheduled'), coveredUntil: queuedEnd };
  const stackedState = passBillingState(stacked, { now: NOW, checkoutOpen: true });
  assert.equal(stackedState.canAddPass, false);
  assert.equal(stackedState.queuedEndsAt, queuedEnd.toISOString());
  // With checkout switched off, never offered.
  assert.equal(passBillingState(active, { now: NOW, checkoutOpen: false }).canAddPass, false);
});

// ---------------------------------------------------------------------------
// Renewal and notice freshness
// ---------------------------------------------------------------------------

test('a renewal is a purchase during a held pass or within 14 days of its end', () => {
  const p = { id: 'a', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z', status: 'expired' as const };
  assert.equal(isPassRenewal([p], new Date('2026-11-20T00:00:00Z')), true);
  assert.equal(isPassRenewal([p], new Date('2026-12-15T00:00:00Z')), true);
  assert.equal(isPassRenewal([p], new Date('2026-12-15T00:00:01Z')), false);
  assert.equal(isPassRenewal([{ ...p, status: 'refunded' }], new Date('2026-11-20T00:00:00Z')), false);
  assert.equal(isPassRenewal([p], new Date('2026-11-20T00:00:00Z'), 'a'), false);
  assert.equal(isPassRenewal([], NOW), false);
});

test('notice freshness: refunded, subscribed, followed by another pass, and timing', () => {
  const ends = new Date(NOW.getTime() + 5 * DAY);
  const row = { id: 'p1', user_id: OWNER, starts_at: new Date(NOW.getTime() - 85 * DAY).toISOString(), ends_at: ends.toISOString(), status: 'active' as const };
  const fresh = (template: string, patch: Partial<Parameters<typeof passNoticeFreshness>[0]> = {}) =>
    passNoticeFreshness({ template, pass: row, userPasses: [row], billing: null, now: NOW, ...patch });
  assert.deepEqual(fresh('pass_ending_7d'), { send: true });
  assert.equal(fresh('pass_ended').send, false);
  assert.deepEqual(fresh('pass_ended', { now: new Date(ends.getTime() + HOUR) }), { send: true });
  assert.deepEqual(fresh('pass_ending_7d', { pass: { ...row, status: 'refunded' } }), { send: false, reason: 'pass_refunded' });
  assert.deepEqual(fresh('pass_ending_7d', { billing: { plan: 'personal', subscription_status: 'active' } }), { send: false, reason: 'subscription_started' });
  const next = { ...row, id: 'p2', starts_at: ends.toISOString(), ends_at: new Date(ends.getTime() + 90 * DAY).toISOString(), status: 'scheduled' as const };
  assert.deepEqual(fresh('pass_ending_7d', { userPasses: [row, next] }), { send: false, reason: 'pass_renewed' });
  assert.deepEqual(fresh('pass_ending_7d', { pass: null }), { send: false, reason: 'no_longer_due' });
});

test('the sink queues exactly two notices per pass, once, and nothing when lifecycle mail is off', async () => {
  const before = process.env.BILLING_LIFECYCLE_EMAILS;
  try {
    const db = new FakeSupabase();
    db.seed('user_billing', [{ user_id: OWNER, stripe_customer_id: 'cus_1' }]);
    db.seed('users', [{ id: OWNER, email: 'Owner@Example.test' }]);
    const notices = [
      { template: 'pass_ending_7d' as const, userId: OWNER, passId: 'p1', endsAt: '2027-03-10T12:00:00.000Z', sendAfter: '2027-03-03T12:00:00.000Z' },
      { template: 'pass_ended' as const, userId: OWNER, passId: 'p1', endsAt: '2027-03-10T12:00:00.000Z', sendAfter: '2027-03-10T12:00:00.000Z' },
    ];
    process.env.BILLING_LIFECYCLE_EMAILS = 'off';
    await passNoticeSink(asClient(db))(notices);
    assert.equal(db.table('billing_email_sends').length, 0);

    process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
    await passNoticeSink(asClient(db))(notices);
    await passNoticeSink(asClient(db))(notices.slice(1));
    const rows = db.table('billing_email_sends');
    assert.deepEqual(rows.map((r) => r.template), ['pass_ending_7d', 'pass_ended']);
    assert.ok(rows.every((r) => r.stripe_customer_id === 'cus_1' && r.scope_key === 'p1' && r.recipient === 'owner@example.test'));
  } finally {
    if (before === undefined) delete process.env.BILLING_LIFECYCLE_EMAILS;
    else process.env.BILLING_LIFECYCLE_EMAILS = before;
  }
});

// ---------------------------------------------------------------------------
// The two emails
// ---------------------------------------------------------------------------

test('pass_ending_7d: the date, what Free means, what stays, and three options', () => {
  const email = composeBillingEmail('pass_ending_7d', { planId: 'personal', periodEnd: '2027-03-10T12:00:00.000Z' });
  assert.ok(email);
  assert.equal(email.category, 'transactional');
  assert.equal(email.unsubscribeUrl, undefined);
  assert.equal(email.subject, 'Your MCPEmails Personal pass ends on 10 March 2027');
  assert.match(email.body, /150 email actions a month and one inbox for new connections/);
  assert.match(email.body, /Your inboxes, drafts and settings stay\./);
  assert.match(email.body, /Subscribe monthly, \$9 a month, first charge on 10 March 2027/);
  assert.match(email.body, /Yearly, \$86\.40 a year, first charge on 10 March 2027/);
  assert.match(email.body, /Another 3 months, \$29, paid once/);
  assert.match(email.body, /checkout\/start\?plan=personal&interval=month/);
  assert.match(email.body, /checkout\/start\?product=personal_pass_3m/);
  for (const word of [/trial/i, /last chance/i, /\bsave\b/i, /—/, /30 days/]) assert.equal(word.test(email.body), false);
});

test('pass_ended: ended, on Free, the options without a first-charge date', () => {
  const email = composeBillingEmail('pass_ended', { planId: 'personal', periodEnd: '2027-03-10T12:00:00.000Z' });
  assert.ok(email);
  assert.equal(email.subject, 'Your MCPEmails Personal pass has ended');
  assert.match(email.body, /ended on 10 March 2027, and the workspace is on Free/);
  assert.equal(/first charge/.test(email.body), false);
  assert.equal(composeBillingEmail('pass_ended', {}), null);
});

// ---------------------------------------------------------------------------
// The board line
// ---------------------------------------------------------------------------

test('the board counts active and this month, never refunded or internal passes', () => {
  const rows = [
    { user_id: 'u1', starts_at: '2026-11-20T00:00:00Z', ends_at: '2027-02-20T00:00:00Z', status: 'active', created_at: '2026-11-20T00:00:00Z' },
    { user_id: 'u2', starts_at: '2026-12-02T00:00:00Z', ends_at: '2027-03-02T00:00:00Z', status: 'active', created_at: '2026-12-02T00:00:00Z' },
    { user_id: 'u3', starts_at: '2026-12-03T00:00:00Z', ends_at: '2027-03-03T00:00:00Z', status: 'refunded', created_at: '2026-12-03T00:00:00Z' },
    { user_id: 'u4', starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z', status: 'expired', created_at: '2026-08-01T00:00:00Z' },
    { user_id: 'me', starts_at: '2026-12-04T00:00:00Z', ends_at: '2027-03-04T00:00:00Z', status: 'active', created_at: '2026-12-04T00:00:00Z' },
  ];
  const summary = summarisePasses(rows, 1, NOW, new Set(['me']));
  assert.deepEqual(summary, { active: 2, soldThisMonth: 1, renewed: 1 });
  assert.equal(passSummaryLine(summary), 'Passes: 2 active, 1 sold this month, 1 renewed');
});

// ---------------------------------------------------------------------------
// A pass holder who also subscribes, or whose subscription is paused
// ---------------------------------------------------------------------------

function seedHolder(db: FakeSupabase, billing: Record<string, unknown> | null) {
  seedWorkspace(db);
  // In the last week, so the reminder would be due on the pass alone.
  db.seed('user_passes', [{ ...pass('held', new Date(NOW.getTime() - 85 * DAY), new Date(NOW.getTime() + 3 * DAY)) }]);
  if (billing) db.seed('user_billing', [{ user_id: OWNER, ...billing }]);
}

test('a subscriber who also holds a pass gets no pass panel and no last-week banner', async () => {
  await withMode('on', async () => {
    const db = new FakeSupabase();
    seedHolder(db, { plan: 'personal', subscription_status: 'trialing', stripe_subscription_id: 'sub_1' });
    assert.equal(await loadPassBillingState(asClient(db), OWNER, true, NOW), null);
    const reminder = await evaluatePassOffer({
      userId: OWNER, workspaceId: WS, surface: 'pass_reminder', now: NOW, db: asClient(db),
    });
    assert.equal(reminder.show, false);
  });
});

test('a holder without a subscription keeps the pass panel and the banner', async () => {
  await withMode('on', async () => {
    const db = new FakeSupabase();
    seedHolder(db, { plan: 'free', subscription_status: 'canceled', stripe_subscription_id: 'sub_old' });
    const state = await loadPassBillingState(asClient(db), OWNER, true, NOW);
    assert.ok(state);
    assert.equal(state.inLastWeek, true);
    assert.equal(state.canAddPass, true);
    const reminder = await evaluatePassOffer({
      userId: OWNER, workspaceId: WS, surface: 'pass_reminder', now: NOW, db: asClient(db),
    });
    assert.equal(reminder.show, true);
    // Somebody else's pass is never theirs to see.
    assert.equal(await loadPassBillingState(asClient(db), OWNER, false, NOW), null);
  });
});

test('a paused subscriber is never offered a pass, and a holder among them cannot add one', async () => {
  const paused = { plan: 'free', subscription_status: 'paused', stripe_subscription_id: 'sub_paused' };
  const base = { isOwner: true, workspacePlan: 'free', billing: null, compedGrant: false, active: null };
  assert.equal(passOfferEligible({ ...base, billing: paused }), false);
  // 'paused' without a stored subscription is not a live subscription.
  assert.equal(passOfferEligible({ ...base, billing: { ...paused, stripe_subscription_id: null } }), true);

  await withMode('on', async () => {
    const db = new FakeSupabase();
    seedWorkspace(db);
    db.seed('user_billing', [{ user_id: OWNER, ...paused }]);
    const offer = await evaluatePassOffer({
      userId: OWNER, workspaceId: WS, surface: 'checkout_return', now: NOW, db: asClient(db), store: store('pass').store,
    });
    assert.equal(offer.show, false);

    const holder = new FakeSupabase();
    seedHolder(holder, paused);
    const state = await loadPassBillingState(asClient(holder), OWNER, true, NOW);
    assert.ok(state, 'the pass is still shown');
    assert.equal(state.canAddPass, false);
    const reminder = await evaluatePassOffer({
      userId: OWNER, workspaceId: WS, surface: 'pass_reminder', now: NOW, db: asClient(holder),
    });
    assert.equal(reminder.show, false);
  });
});
