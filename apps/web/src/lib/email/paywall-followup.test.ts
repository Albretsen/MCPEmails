/**
 * Tests for the paywall follow-up sequence: trigger, stop conditions,
 * idempotency, and what every email must carry.
 *
 * NOTHING HERE TOUCHES A NETWORK OR SENDS MAIL. The store is the in-memory
 * MemoryStore below, which enforces the ledger's real primary key
 * (user_id, template, trigger_key) the way ON CONFLICT DO NOTHING does, and
 * the sender is a function that records what it was handed.
 *
 * The yearly price ids are placeholders set BEFORE plans.ts loads (it reads
 * them at import), so the annual sentence renders; they never reach Stripe.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/paywall-followup.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Both names: the Personal yearly id moved to a _V2 variable in the $9 reprice.
process.env.STRIPE_PRICE_PERSONAL_YEARLY ??= 'price_test_personal_yearly';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 ??= 'price_test_personal_yearly';
process.env.STRIPE_PRICE_SOLO_YEARLY ??= 'price_test_solo_yearly';
process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
delete process.env.RESEND_API_KEY;

const followup = await import('@/lib/email/paywall-followup');
const templates = await import('@/lib/email/paywall-followup-templates');
const { PLANS, FREE_ACTION_ALLOWANCE } = await import('@/lib/stripe/plans');
const { annualOfferFromPlan, formatPriceCents } = await import('@/lib/stripe/annual-offer');
const { POSTAL_ADDRESS_LINE } = await import('@/lib/email/legal');
const { matchesInternal } = await import('@/lib/email/paywall-followup-store');

type Ctx = import('@/lib/email/paywall-followup').CandidateContext;
type ClaimRow = import('@/lib/email/paywall-followup').ClaimRow;
type FirstPaywall = import('@/lib/email/paywall-followup').FirstPaywall;
type LedgerRow = import('@/lib/email/paywall-followup').LedgerRow;
type OutgoingEmail = import('@/lib/email/paywall-followup').OutgoingEmail;
type Step = 1 | 2 | 3;

const { decide, runPaywallFollowup, pickFirstPaywalls, templateFor } = followup;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-09-20T10:00:00.000Z'); // the first paywall
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const WS = 'ws-00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000aa';
const TOKEN = '11111111-2222-4333-8444-555555555555';

function ctx(overrides: Partial<Ctx> = {}, owner: Partial<NonNullable<Ctx['owner']>> = {}): Ctx {
  return {
    workspaceId: WS,
    firstPaywallAt: T0.toISOString(),
    paywallKind: 'inbox_cap',
    workspace: { ownerId: USER, plan: 'free', deletedAt: null },
    owner: {
      id: USER,
      email: 'owner@example.test',
      marketingConsentAt: at(-DAY).toISOString(),
      unsubscribedAt: null,
      unsubscribedCategories: [],
      unsubscribeToken: TOKEN,
      ...owner,
    },
    subscriptionStatus: null,
    unlimitedInboxes: false,
    internal: false,
    inboxCount: 1,
    ledger: [],
    ...overrides,
  };
}

function sentRow(step: Step, sentAtMs: number, triggerKey = WS): LedgerRow {
  const iso = at(sentAtMs).toISOString();
  return { template: templateFor(step), triggerKey, status: 'sent', detail: null, sentAt: iso, finishedAt: iso };
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface StoredRow extends LedgerRow {
  userId: string;
  email: string;
  providerId: string | null;
}

class MemoryStore {
  contexts: Ctx[];
  rows: StoredRow[] = [];
  claims = 0;
  readOnly = false;
  /** The simulated wall clock the ledger timestamps use. */
  clock = at(2 * HOUR);

  constructor(contexts: Ctx[]) {
    this.contexts = contexts;
  }

  async listFirstPaywalls(): Promise<FirstPaywall[]> {
    return this.contexts.map(({ workspaceId, firstPaywallAt, paywallKind }) => ({ workspaceId, firstPaywallAt, paywallKind }));
  }

  async loadContexts(firsts: FirstPaywall[]): Promise<Ctx[]> {
    await Promise.resolve();
    return firsts
      .map((f) => this.contexts.find((c) => c.workspaceId === f.workspaceId))
      .filter((c): c is Ctx => Boolean(c))
      .map((c) => ({
        ...c,
        ledger: this.rows
          .filter((r) => r.userId === c.owner?.id)
          .map(({ template, triggerKey, status, detail, sentAt, finishedAt }) => ({ template, triggerKey, status, detail, sentAt, finishedAt })),
      }));
  }

  /** ON CONFLICT (user_id, template, trigger_key) DO NOTHING, atomically. */
  async claim(row: ClaimRow): Promise<boolean> {
    if (this.readOnly) throw new Error('claim called in a read-only run');
    this.claims += 1;
    await Promise.resolve();
    const template = templateFor(row.step);
    const clash = this.rows.some((r) => r.userId === row.userId && r.template === template && r.triggerKey === row.workspaceId);
    if (clash) return false;
    this.rows.push({
      userId: row.userId,
      template,
      triggerKey: row.workspaceId,
      status: row.status,
      detail: row.detail,
      sentAt: this.clock.toISOString(),
      finishedAt: null,
      email: row.email,
      providerId: null,
    });
    return true;
  }

  async finish(
    key: { userId: string; workspaceId: string; step: Step },
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void> {
    if (this.readOnly) throw new Error('finish called in a read-only run');
    const row = this.rows.find(
      (r) => r.userId === key.userId && r.template === templateFor(key.step) && r.triggerKey === key.workspaceId && r.status === 'claimed',
    );
    if (!row) return;
    row.status = outcome.status;
    row.finishedAt = this.clock.toISOString();
    if (outcome.status === 'sent') row.providerId = outcome.providerId;
    else row.detail = outcome.detail;
  }
}

function recordingSender(result: { ok: true; id: string } | { ok: false; reason: string } = { ok: true, id: 'em_1' }, delayMs = 0) {
  const sent: OutgoingEmail[] = [];
  const send = async (email: OutgoingEmail) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    sent.push(email);
    return result;
  };
  return { sent, send };
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

test('trigger: only the FIRST paywall of a workspace counts', () => {
  const firsts = pickFirstPaywalls(
    [
      { workspace_id: 'a', occurred_at: at(2 * HOUR).toISOString(), connection_type: null },
      { workspace_id: 'a', occurred_at: at(0).toISOString(), connection_type: 'first_connect' },
      { workspace_id: 'b', occurred_at: at(0).toISOString(), connection_type: null },
    ],
    new Set(['b']), // b had a paywall before the window: its hit in the window is not a first
  );
  assert.deepEqual(firsts, [{ workspaceId: 'a', firstPaywallAt: at(0).toISOString(), paywallKind: 'inbox_cap' }]);
});

test('trigger: action-cap paywall rows (NULL connection_type) are labelled action_cap', () => {
  const [f] = pickFirstPaywalls([{ workspace_id: 'c', occurred_at: at(0).toISOString(), connection_type: null }], new Set());
  assert.equal(f.paywallKind, 'action_cap');
});

test('trigger: step 1 waits until an hour after the paywall, then sends', () => {
  assert.deepEqual(decide(ctx(), at(30 * 60_000)), { kind: 'wait', step: 1, dueAt: at(HOUR).toISOString() });
  assert.deepEqual(decide(ctx(), at(HOUR + 1)), { kind: 'send', step: 1 });
});

test('trigger: a paywall BEFORE consent never starts the sequence, and nothing is recorded', () => {
  const d = decide(ctx({}, { marketingConsentAt: at(HOUR / 2).toISOString() }), at(2 * HOUR));
  assert.deepEqual(d, { kind: 'stop', step: 1, reason: 'paywall_before_consent', persist: false });
});

test('trigger: no consent means no email', () => {
  const d = decide(ctx({}, { marketingConsentAt: null }), at(2 * HOUR));
  assert.deepEqual(d, { kind: 'stop', step: 1, reason: 'no_consent', persist: false });
});

test('trigger: internal accounts are ignored and not recorded', () => {
  const d = decide(ctx({ internal: true }), at(2 * HOUR));
  assert.deepEqual(d, { kind: 'stop', step: 1, reason: 'internal', persist: false });
});

test('trigger: internal matching covers the table list, plus tags and our domains', () => {
  const listed = new Set(['founder@example.test']);
  assert.equal(matchesInternal('Founder+test@Example.test', listed), true);
  assert.equal(matchesInternal('someone@mcpemails.com', new Set()), true);
  assert.equal(matchesInternal('customer@example.test', listed), false);
});

test('trigger: an old paywall past the step 1 window is never sent late or recorded', () => {
  const d = decide(ctx(), at(2 * DAY));
  assert.deepEqual(d, { kind: 'stop', step: 1, reason: 'window_missed', persist: false });
});

test('trigger: one sequence per person across workspaces', () => {
  const d = decide(ctx({ ledger: [sentRow(1, HOUR, 'ws-other')] }), at(2 * HOUR));
  assert.deepEqual(d, { kind: 'stop', step: 1, reason: 'enrolled_elsewhere', persist: false });
});

// ---------------------------------------------------------------------------
// Stop conditions, at send time, on every step
// ---------------------------------------------------------------------------

const midSequence = { ledger: [sentRow(1, HOUR)] };
const step2Time = at(3 * DAY + HOUR);

test('step 2 waits for 3 days, then sends if step 1 was sent', () => {
  assert.equal(decide(ctx(midSequence), at(2 * DAY)).kind, 'wait');
  assert.deepEqual(decide(ctx(midSequence), step2Time), { kind: 'send', step: 2 });
});

const stops: Array<[string, Partial<Ctx>, Partial<NonNullable<Ctx['owner']>>, string]> = [
  ['subscribed (active subscription)', { subscriptionStatus: 'active' }, {}, 'subscribed'],
  ['subscribed (trialing)', { subscriptionStatus: 'trialing' }, {}, 'subscribed'],
  ['subscribed (workspace on a paid plan)', { workspace: { ownerId: USER, plan: 'personal', deletedAt: null } }, {}, 'subscribed'],
  ['unsubscribed from everything', {}, { unsubscribedAt: at(DAY).toISOString() }, 'unsubscribed'],
  ['unsubscribed from the lifecycle category', {}, { unsubscribedCategories: ['lifecycle'] }, 'unsubscribed_lifecycle'],
  ['workspace deleted', { workspace: { ownerId: USER, plan: 'free', deletedAt: at(DAY).toISOString() } }, {}, 'workspace_deleted'],
  ['consent withdrawn', {}, { marketingConsentAt: null }, 'no_consent'],
  ['no unsubscribe token', {}, { unsubscribeToken: null }, 'no_unsubscribe_token'],
  ['grandfathered unlimited inboxes', { unlimitedInboxes: true }, {}, 'unlimited_inboxes'],
];

for (const [name, overrides, owner, reason] of stops) {
  test(`stop at step 1: ${name}`, () => {
    const d = decide(ctx(overrides, owner), at(2 * HOUR));
    assert.equal(d.kind, 'stop');
    assert.equal(d.kind === 'stop' && d.reason, reason);
  });
  test(`stop mid-sequence (step 2), recorded: ${name}`, () => {
    const d = decide(ctx({ ...midSequence, ...overrides }, owner), step2Time);
    assert.deepEqual(d, { kind: 'stop', step: 2, reason, persist: true });
  });
}

test('an unrelated category opt-out does not stop this sequence', () => {
  assert.deepEqual(decide(ctx({}, { unsubscribedCategories: ['research'] }), at(2 * HOUR)), { kind: 'send', step: 1 });
});

test('a failed step ends the sequence: failed rows are never retried', () => {
  const failed: LedgerRow = { ...sentRow(1, HOUR), status: 'failed', detail: 'rate_limited' };
  assert.deepEqual(decide(ctx({ ledger: [failed] }), step2Time), { kind: 'done', reason: 'ended_at_step_1_rate_limited' });
});

test('a claimed-but-unfinished row (crash mid-send) ends the sequence', () => {
  const claimed: LedgerRow = { ...sentRow(1, HOUR), status: 'claimed', finishedAt: null };
  assert.equal(decide(ctx({ ledger: [claimed] }), at(HOUR * 2)).kind, 'done');
});

test('a recorded stop stays stopped even after the condition flips back', () => {
  const skipped: LedgerRow = { ...sentRow(2, 3 * DAY), status: 'skipped', detail: 'subscribed' };
  const d = decide(ctx({ ledger: [sentRow(1, HOUR), skipped] }), at(7 * DAY + HOUR));
  assert.deepEqual(d, { kind: 'done', reason: 'ended_at_step_2_subscribed' });
});

test('step 3 after step 2, and the sequence completes', () => {
  const ledger = [sentRow(1, HOUR), sentRow(2, 3 * DAY + HOUR)];
  assert.deepEqual(decide(ctx({ ledger }), at(7 * DAY + HOUR)), { kind: 'send', step: 3 });
  assert.deepEqual(decide(ctx({ ledger: [...ledger, sentRow(3, 7 * DAY + HOUR)] }), at(8 * DAY)), { kind: 'done', reason: 'completed' });
});

test('a missed step 2 window is recorded and ends the sequence', () => {
  assert.deepEqual(decide(ctx(midSequence), at(6 * DAY)), { kind: 'stop', step: 2, reason: 'window_missed', persist: true });
});

// ---------------------------------------------------------------------------
// The run: idempotency, dry run, switches
// ---------------------------------------------------------------------------

test('dry run selects and renders but never claims, writes or sends', async () => {
  const store = new MemoryStore([ctx()]);
  store.readOnly = true;
  const report = await runPaywallFollowup({ store, mode: 'dry_run', now: at(2 * HOUR) });
  assert.equal(report.wouldSend.step1, 1);
  assert.equal(report.sent, 0);
  assert.equal(store.claims, 0);
  assert.equal(report.entries[0].subject, templates.composePaywallFollowup({ step: 1, paywallKind: 'inbox_cap', unsubscribeToken: TOKEN })?.subject);
  assert.notEqual(report.entries[0].workspace, WS, 'report must carry a hash, not the id');
});

test('ignoreConsent is a report-only option and refuses to send', async () => {
  const store = new MemoryStore([ctx({}, { marketingConsentAt: null })]);
  await assert.rejects(runPaywallFollowup({ store, mode: 'send', send: recordingSender().send, ignoreConsent: true, now: at(2 * HOUR) }));
  const dry = await runPaywallFollowup({ store, mode: 'dry_run', ignoreConsent: true, now: at(2 * HOUR) });
  assert.equal(dry.wouldSend.step1, 1);
});

test('send: claim, send, record sent with the provider id and the idempotency key', async () => {
  const store = new MemoryStore([ctx()]);
  const { sent, send } = recordingSender({ ok: true, id: 'em_42' });
  const report = await runPaywallFollowup({ store, mode: 'send', send, now: at(2 * HOUR) });
  assert.equal(report.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, `paywall_followup_1-${WS}`);
  assert.equal(store.rows[0].status, 'sent');
  assert.equal(store.rows[0].providerId, 'em_42');
  // A second run in the same hour sends nothing: step 2 is not due.
  const again = await runPaywallFollowup({ store, mode: 'send', send, now: at(3 * HOUR) });
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 1);
});

test('concurrent runs: exactly one wins the claim and one email goes out', async () => {
  const store = new MemoryStore([ctx()]);
  const { sent, send } = recordingSender({ ok: true, id: 'em_1' }, 20);
  const [a, b] = await Promise.all([
    runPaywallFollowup({ store, mode: 'send', send, now: at(2 * HOUR) }),
    runPaywallFollowup({ store, mode: 'send', send, now: at(2 * HOUR) }),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(a.lostClaims + b.lostClaims, 1);
  assert.equal(store.rows.length, 1);
});

test('a failed send is kept as failed and never retried', async () => {
  const store = new MemoryStore([ctx()]);
  const failing = recordingSender({ ok: false, reason: 'rate_limited' });
  const r1 = await runPaywallFollowup({ store, mode: 'send', send: failing.send, now: at(2 * HOUR) });
  assert.equal(r1.failed, 1);
  assert.equal(store.rows[0].status, 'failed');
  assert.equal(store.rows[0].detail, 'rate_limited');

  const ok = recordingSender();
  for (const when of [at(3 * HOUR), at(3 * DAY + HOUR), at(7 * DAY + HOUR)]) {
    store.clock = when;
    await runPaywallFollowup({ store, mode: 'send', send: ok.send, now: when });
  }
  assert.equal(ok.sent.length, 0, 'no retry of step 1 and no later steps');
  assert.equal(store.rows.length, 1);
});

test('a sender that throws is recorded as failed, not left claimed', async () => {
  const store = new MemoryStore([ctx()]);
  const report = await runPaywallFollowup({
    store,
    mode: 'send',
    send: async () => {
      throw new Error('socket hang up');
    },
    now: at(2 * HOUR),
  });
  assert.equal(report.failed, 1);
  assert.equal(store.rows[0].status, 'failed');
});

test('a persistent stop is recorded as a skipped row through the same claim', async () => {
  const c = ctx({ ...midSequence, subscriptionStatus: 'active' });
  const store = new MemoryStore([c]);
  store.rows.push({ ...sentRow(1, HOUR), userId: USER, email: 'owner@example.test', providerId: 'em_0' });
  const { sent, send } = recordingSender();
  const report = await runPaywallFollowup({ store, mode: 'send', send, now: step2Time });
  assert.equal(sent.length, 0);
  assert.equal(report.skippedRecorded, 1);
  assert.deepEqual(
    store.rows.map((r) => [r.template, r.status, r.detail]),
    [['paywall_followup_1', 'sent', null], ['paywall_followup_2', 'skipped', 'subscribed']],
  );
});

test('the full sequence over ten days sends 1, 2, 3 once each', async () => {
  const store = new MemoryStore([ctx()]);
  const { sent, send } = recordingSender();
  for (let h = 0; h <= 10 * 24; h += 1) {
    store.clock = at(h * HOUR + 60_000);
    await runPaywallFollowup({ store, mode: 'send', send, now: store.clock });
  }
  assert.deepEqual(sent.map((e) => e.idempotencyKey), [1, 2, 3].map((s) => `paywall_followup_${s}-${WS}`));
});

test('maxSends caps a run', async () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    ctx({ workspaceId: `ws-${i}`, workspace: { ownerId: `u-${i}`, plan: 'free', deletedAt: null } }, { id: `u-${i}` }),
  );
  const store = new MemoryStore(many);
  const { sent, send } = recordingSender();
  const report = await runPaywallFollowup({ store, mode: 'send', send, now: at(2 * HOUR), maxSends: 2 });
  assert.equal(sent.length, 2);
  assert.equal(report.truncated, true);
});

test('switches: off by default, dry run unless explicitly disabled', () => {
  const { paywallFollowupMode, paywallFollowupMaxPerRun } = followup;
  assert.equal(paywallFollowupMode({}), 'off');
  assert.equal(paywallFollowupMode({ PAYWALL_FOLLOWUP_ENABLED: 'yes' }), 'off');
  assert.equal(paywallFollowupMode({ PAYWALL_FOLLOWUP_ENABLED: 'on' }), 'dry_run');
  assert.equal(paywallFollowupMode({ PAYWALL_FOLLOWUP_ENABLED: 'on', PAYWALL_FOLLOWUP_DRY_RUN: 'flase' }), 'dry_run');
  assert.equal(paywallFollowupMode({ PAYWALL_FOLLOWUP_ENABLED: 'on', PAYWALL_FOLLOWUP_DRY_RUN: 'false' }), 'send');
  assert.equal(paywallFollowupMode({ PAYWALL_FOLLOWUP_DRY_RUN: 'false' }), 'off');
  assert.equal(paywallFollowupMaxPerRun({}), 20);
  assert.equal(paywallFollowupMaxPerRun({ PAYWALL_FOLLOWUP_MAX_PER_RUN: '5000' }), 100);
});

// ---------------------------------------------------------------------------
// Every template: compliance and plan claims
// ---------------------------------------------------------------------------

const kinds = ['inbox_cap', 'action_cap', 'unknown'] as const;
const all = ([1, 2, 3] as const).flatMap((step) =>
  kinds.map((paywallKind) => ({ step, paywallKind, email: templates.composePaywallFollowup({ step, paywallKind, unsubscribeToken: TOKEN })! })),
);

test('no unsubscribe token, no email', () => {
  assert.equal(templates.composePaywallFollowup({ step: 1, paywallKind: 'inbox_cap', unsubscribeToken: null }), null);
  assert.equal(templates.composePaywallFollowup({ step: 1, paywallKind: 'inbox_cap', unsubscribeToken: '  ' }), null);
});

for (const { step, paywallKind, email } of all) {
  test(`step ${step} (${paywallKind}): unsubscribe headers, own-token link, postal line`, () => {
    const url = `https://mcpemails.test/api/email/unsubscribe?token=${TOKEN}&c=lifecycle`;
    assert.equal(email.unsubscribeUrl, url);
    assert.equal(email.headers['List-Unsubscribe'], `<${url}>`);
    assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(email.text.includes(url), 'visible link in the text body');
    assert.ok(email.html.includes(url.replace(/&/g, '&amp;')), 'visible link in the HTML body');
    assert.ok(email.text.includes(POSTAL_ADDRESS_LINE));
    assert.ok(email.html.includes(POSTAL_ADDRESS_LINE));
  });

  test(`step ${step} (${paywallKind}): honest subject, no em dashes, no addresses in the body`, () => {
    assert.doesNotMatch(email.subject, /^(re|fwd?):/i);
    assert.doesNotMatch(email.subject, /urgent|last chance|expires|act now|!/i);
    for (const part of [email.subject, email.text, email.html]) assert.ok(!part.includes('\u2014'), 'no em dash');
    assert.ok(!email.text.includes('@'), 'no email address of any kind in the text body');
  });

  test(`step ${step} (${paywallKind}): every price and inbox count comes from plans.ts`, () => {
    const allowed = new Set<string>();
    for (const plan of [PLANS.free, PLANS.personal, PLANS.solo]) {
      allowed.add(formatPriceCents(plan.monthlyPriceCents));
      if (plan.yearlyPriceCents) allowed.add(formatPriceCents(plan.yearlyPriceCents));
    }
    for (const price of email.text.match(/\$\d+(?:\.\d{2})?/g) ?? []) {
      assert.ok(allowed.has(price), `${price} is not a catalogue price`);
    }
    if (step !== 3) return;
    assert.ok(email.text.includes(`${PLANS.personal.name}, ${formatPriceCents(PLANS.personal.monthlyPriceCents)} a month`));
    assert.ok(email.text.includes(`${PLANS.solo.name}, ${formatPriceCents(PLANS.solo.monthlyPriceCents)} a month`));
    assert.ok(email.text.includes(templates.inboxLine(PLANS.personal).toLowerCase()));
    assert.ok(email.text.includes(`${PLANS.free.limits.maxInboxes} connected inbox`));
    assert.ok(email.text.includes(`${FREE_ACTION_ALLOWANCE} email actions a month`));
  });

  test(`step ${step} (${paywallKind}): free features are never sold as paid`, () => {
    if (/scheduled send/i.test(email.text)) assert.match(email.text, /Scheduled send (is|and the approval hold are) on every plan, Free included/);
    if (/approval hold/i.test(email.text)) assert.match(email.text, /approval hold are on every plan/);
  });
}

test('step 1 names Personal and Pro inbox counts from the catalogue', () => {
  const text = all.find((e) => e.step === 1)!.email.text;
  assert.ok(text.includes(`${formatPriceCents(PLANS.personal.monthlyPriceCents)} a month for ${templates.inboxLine(PLANS.personal).toLowerCase()}`));
  assert.ok(text.includes(`${formatPriceCents(PLANS.solo.monthlyPriceCents)} a month for ${templates.inboxLine(PLANS.solo).toLowerCase()}`));
});

test('step 3: monthly first, annual as the option, saving computed not written', () => {
  const text = all.find((e) => e.step === 3)!.email.text;
  const personal = annualOfferFromPlan(PLANS.personal);
  const pro = annualOfferFromPlan(PLANS.solo);
  assert.ok(personal && pro, 'yearly placeholders make annual sellable in this test');
  assert.ok(text.includes(formatPriceCents(personal.yearlyPriceCents)));
  assert.ok(text.includes(formatPriceCents(pro.yearlyPriceCents)));
  if (personal.savingPercent === pro.savingPercent) assert.ok(text.includes(`saves ${personal.savingPercent}%`));
  assert.ok(text.indexOf('a month') < text.indexOf('a year'), 'monthly is presented before annual');
  assert.ok(text.includes('interval=month'), 'the link preselects monthly');
});
