/**
 * Tests for the monthly Free reset email: who is selected, the arms, the
 * holdout, idempotency and the copy. No network: an in-memory store that
 * enforces the ledger's primary key, and a recording sender.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/free-reset-email.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
delete process.env.RESEND_API_KEY;

const reset = await import('@/lib/email/free-reset-email');
const { composeFreeReset } = await import('@/lib/email/free-reset-email-template');
const { FREE_ACTION_ALLOWANCE, PLANS } = await import('@/lib/stripe/plans');
const { formatPriceCents } = await import('@/lib/stripe/annual-offer');
const { POSTAL_ADDRESS_LINE } = await import('@/lib/email/legal');

type Ctx = import('@/lib/email/free-reset-email').CandidateContext;
type ClaimRow = import('@/lib/email/free-reset-email').ClaimRow;
type Candidate = import('@/lib/email/free-reset-email').Candidate;
type OutgoingEmail = import('@/lib/email/free-reset-email').OutgoingEmail;

const { decide, runFreeReset, previousMonth, refusedDaysByWorkspace } = reset;

const NOW = new Date('2026-12-02T07:05:00.000Z');
const LIVE = { startAt: new Date('2026-12-02T07:00:00.000Z'), live: true };
const DRY = { startAt: LIVE.startAt, live: false };
const TOKEN = '11111111-2222-4333-8444-555555555555';

function wsInArm(holdout: boolean, salt = ''): string {
  for (let i = 0; i < 1000; i += 1) {
    const id = `ws-reset-${salt}${i}`;
    if (reset.isHoldout(id) === holdout) return id;
  }
  throw new Error('no id');
}

function ctx(over: Partial<Ctx> = {}, owner: Partial<NonNullable<Ctx['owner']>> = {}): Ctx {
  const ownerId = owner.id ?? 'u1';
  return {
    workspaceId: wsInArm(false),
    refusedDays: 3,
    workspace: { ownerId, plan: 'free', deletedAt: null },
    allowance: { plan: 'free', exempt: false, cap: FREE_ACTION_ALLOWANCE },
    owner: {
      id: ownerId,
      email: 'owner@example.test',
      marketingConsentAt: null,
      unsubscribedAt: null,
      unsubscribedCategories: [],
      unsubscribeToken: TOKEN,
      ...owner,
    },
    subscriptionStatus: null,
    internal: false,
    ownerCountries: ['US'],
    ledger: [],
    ...over,
  };
}

class MemoryStore {
  rows: Array<Omit<ClaimRow, 'status'> & { status: string; providerId: string | null }> = [];
  claims = 0;
  readOnly = false;
  contexts: Ctx[];
  constructor(contexts: Ctx[]) {
    this.contexts = contexts;
  }
  async listCandidates(): Promise<Candidate[]> {
    return this.contexts.map(({ workspaceId, refusedDays }) => ({ workspaceId, refusedDays }));
  }
  async loadContexts(cands: Candidate[]): Promise<Ctx[]> {
    return cands
      .map((c) => this.contexts.find((x) => x.workspaceId === c.workspaceId)!)
      .map((c) => ({
        ...c,
        ledger: this.rows.filter((r) => r.userId === c.owner?.id).map((r) => ({ triggerKey: r.monthKey, status: r.status })),
      }));
  }
  async claim(row: ClaimRow): Promise<boolean> {
    if (this.readOnly) throw new Error('claim in a read-only run');
    this.claims += 1;
    if (this.rows.some((r) => r.userId === row.userId && r.monthKey === row.monthKey)) return false;
    this.rows.push({ ...row, providerId: null });
    return true;
  }
  async finish(
    key: { userId: string; monthKey: string },
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void> {
    const row = this.rows.find((r) => r.userId === key.userId && r.monthKey === key.monthKey && r.status === 'claimed');
    if (!row) return;
    row.status = outcome.status;
    if (outcome.status === 'sent') row.providerId = outcome.providerId;
    else row.detail = outcome.detail;
  }
}

function recordingSender() {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    send: async (email: OutgoingEmail) => {
      sent.push(email);
      return { ok: true as const, id: 'em_1' };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('previousMonth: the UTC calendar month before now, also across a year', () => {
  assert.deepEqual(
    { ...previousMonth(NOW), start: previousMonth(NOW).start.toISOString(), end: previousMonth(NOW).end.toISOString() },
    { key: '2026-11', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
  );
  assert.equal(previousMonth(new Date('2027-01-02T07:00:00Z')).key, '2026-12');
});

test('refused days are distinct UTC days per workspace', () => {
  const days = refusedDaysByWorkspace([
    { workspace_id: 'a', occurred_at: '2026-11-03T01:00:00Z' },
    { workspace_id: 'a', occurred_at: '2026-11-03T23:59:00Z' },
    { workspace_id: 'a', occurred_at: '2026-11-04T00:00:01Z' },
    { workspace_id: 'b', occurred_at: '2026-11-05T10:00:00Z' },
    { workspace_id: 'b', occurred_at: 'nonsense' },
  ]);
  assert.equal(days.get('a'), 2);
  assert.equal(days.get('b'), 1);
});

test('two or more refused days are needed; one is not enough', () => {
  assert.equal(decide(ctx({ refusedDays: 2 }), NOW, '2026-11', LIVE).kind, 'send');
  assert.deepEqual(decide(ctx({ refusedDays: 1 }), NOW, '2026-11', LIVE), { kind: 'skip', reason: 'too_few_days' });
});

test('nothing before the start date, and only on days 2 to 7 of a month', () => {
  assert.deepEqual(decide(ctx(), new Date('2026-12-02T06:59:00Z'), '2026-11', LIVE), { kind: 'skip', reason: 'not_started' });
  assert.deepEqual(decide(ctx(), NOW, '2026-11', { startAt: null, live: true }), { kind: 'skip', reason: 'not_started' });
  assert.deepEqual(decide(ctx(), new Date('2026-12-01T09:00:00Z'), '2026-11', { ...LIVE, startAt: new Date('2026-11-01T00:00:00Z') }), {
    kind: 'skip',
    reason: 'outside_send_days',
  });
  assert.deepEqual(decide(ctx(), new Date('2026-12-08T09:00:00Z'), '2026-11', LIVE), { kind: 'skip', reason: 'outside_send_days' });
  assert.equal(decide(ctx(), new Date('2026-12-07T23:00:00Z'), '2026-11', LIVE).kind, 'send');
});

test('only metered Free workspaces of unsubscribed-from-nothing, external owners', () => {
  const cases: Array<[Ctx, string]> = [
    [ctx({ workspace: { ownerId: 'u1', plan: 'personal', deletedAt: null } }), 'not_free'],
    [ctx({ subscriptionStatus: 'active' }), 'subscribed'],
    [ctx({ subscriptionStatus: 'trialing' }), 'subscribed'],
    [ctx({ subscriptionStatus: 'past_due' }), 'subscribed'],
    [ctx({ allowance: { plan: 'free', exempt: true, cap: null } }), 'not_metered'],
    [ctx({ allowance: null }), 'allowance_unknown'],
    [ctx({ internal: true }), 'internal'],
    [ctx({ workspace: { ownerId: 'u1', plan: 'free', deletedAt: '2026-11-20T00:00:00Z' } }), 'workspace_deleted'],
    [ctx({}, { unsubscribedAt: '2026-11-01T00:00:00Z' }), 'unsubscribed'],
    [ctx({}, { unsubscribedCategories: ['lifecycle'] }), 'unsubscribed_lifecycle'],
    [ctx({}, { unsubscribeToken: null }), 'no_unsubscribe_token'],
    [ctx({}, { email: 'not-an-address' }), 'unusable_email'],
    [ctx({ ledger: [{ triggerKey: '2026-11', status: 'sent' }] }), 'already_this_month'],
  ];
  for (const [c, reason] of cases) assert.deepEqual(decide(c, NOW, '2026-11', LIVE), { kind: 'skip', reason }, reason);
  // Last month's email does not block this month's.
  assert.equal(decide(ctx({ ledger: [{ triggerKey: '2026-10', status: 'sent' }] }), NOW, '2026-11', LIVE).kind, 'send');
});

test('arms: consented anywhere, soft opt-in outside Europe, notice for Europe and unknown', () => {
  const arm = (c: Ctx) => {
    const d = decide(c, NOW, '2026-11', LIVE);
    return d.kind === 'skip' ? d.reason : d.arm;
  };
  assert.equal(arm(ctx({ ownerCountries: ['DE'] }, { marketingConsentAt: '2026-01-01T00:00:00Z' })), 'consented');
  assert.equal(arm(ctx({ ownerCountries: ['US'] })), 'soft_opt_in');
  assert.equal(arm(ctx({ ownerCountries: ['NO'] })), 'service_notice');
  assert.equal(arm(ctx({ ownerCountries: [null] })), 'service_notice');
});

test('holdout: 20% of workspaces, in every arm', () => {
  let held = 0;
  for (let i = 0; i < 2000; i += 1) if (reset.isHoldout(`ws-${i}`)) held += 1;
  assert.ok(held > 300 && held < 500, `held ${held}`);
  for (const countries of [['US'], ['FR']]) {
    assert.equal(decide(ctx({ workspaceId: wsInArm(true), ownerCountries: countries }), NOW, '2026-11', LIVE).kind, 'holdout');
  }
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('run: unset start reads nothing at all', async () => {
  const store = new MemoryStore([ctx()]);
  let listed = false;
  store.listCandidates = async () => {
    listed = true;
    return [];
  };
  const r = await runFreeReset({ store, mode: 'send', send: recordingSender().send, expansion: { startAt: null, live: true }, now: NOW });
  assert.equal(listed, false);
  assert.equal(r.sent, 0);
});

test('run: dry run (expansion not live) writes and sends nothing', async () => {
  const store = new MemoryStore([ctx(), ctx({ workspaceId: wsInArm(true, 'h'), ownerCountries: ['NO'] }, { id: 'u2' })]);
  store.readOnly = true;
  const s = recordingSender();
  const r = await runFreeReset({ store, mode: 'send', send: s.send, expansion: DRY, now: NOW });
  assert.equal(r.mode, 'dry_run');
  assert.equal(r.wouldSend, 1);
  assert.equal(r.wouldHoldOut, 1);
  assert.equal(s.sent.length, 0);
  assert.equal(store.claims, 0);
});

test('run: live sends once per owner per month, holdout rows written, idempotent', async () => {
  const store = new MemoryStore([
    ctx({ refusedDays: 5 }),
    // Same owner, second workspace: one email per owner per month.
    ctx({ workspaceId: wsInArm(false, 'b'), refusedDays: 2 }),
    ctx({ workspaceId: wsInArm(true, 'h'), ownerCountries: ['NO'] }, { id: 'u2' }),
  ]);
  const s = recordingSender();
  const r = await runFreeReset({ store, mode: 'send', send: s.send, expansion: LIVE, now: NOW });
  assert.equal(r.sent, 1);
  assert.equal(r.heldOut, 1);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].idempotencyKey, 'free_reset-2026-11-u1');
  assert.match(s.sent[0].text, /refused on 5 days/);
  const u1 = store.rows.find((x) => x.userId === 'u1')!;
  assert.equal(u1.status, 'sent');
  assert.equal(u1.detail, 'soft_opt_in');
  const u2 = store.rows.find((x) => x.userId === 'u2')!;
  assert.equal(u2.status, 'holdout');
  assert.equal(u2.detail, 'service_notice');

  const again = await runFreeReset({ store, mode: 'send', send: s.send, expansion: LIVE, now: new Date('2026-12-02T09:05:00Z') });
  assert.equal(again.sent, 0);
  assert.equal(s.sent.length, 1);
});

test('run: the pass line is asked for promotional arms only', async () => {
  const asked: string[] = [];
  const passOffer = async (workspaceId: string) => {
    asked.push(workspaceId);
    return { endsOn: '2 March 2027', url: 'https://mcpemails.test/api/stripe/checkout/start?product=personal_pass_3m' };
  };
  const notice = ctx({ ownerCountries: ['SE'] }, { id: 'u3' });
  const promo = ctx({ workspaceId: wsInArm(false, 'p') }, { id: 'u4' });
  const s = recordingSender();
  await runFreeReset({ store: new MemoryStore([notice, promo]), mode: 'send', send: s.send, expansion: LIVE, now: NOW, passOffer });
  assert.deepEqual(asked, [promo.workspaceId]);
  const promoMail = s.sent.find((m) => m.text.includes('Personal removes'))!;
  assert.match(promoMail.text, /3 months, paid once/);
  const noticeMail = s.sent.find((m) => !m.text.includes('Personal removes'))!;
  assert.doesNotMatch(noticeMail.text, /\$|paid once/);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('copy: promotional version names the Personal price and the usage_limit_reached upgrade path', () => {
  const m = composeFreeReset({ arm: 'soft_opt_in', refusedDays: 4, resetOn: new Date('2026-12-01T00:00:00Z'), unsubscribeToken: TOKEN })!;
  assert.equal(m.subject, 'Your Free email actions have reset');
  assert.match(m.text, new RegExp(`allowance of ${FREE_ACTION_ALLOWANCE} email actions started over on 1 December`));
  assert.match(m.text, /refused on 4 days/);
  assert.ok(m.text.includes(`Personal removes the monthly limit for ${formatPriceCents(PLANS.personal.monthlyPriceCents).replace(/\.00$/, '')} a month.`));
  assert.ok(m.text.includes('https://mcpemails.test/dashboard/settings?upgrade=personal&interval=month&offer=usage_cap'));
  assert.ok(m.text.includes('https://mcpemails.test/dashboard/usage'));
  assert.ok(m.text.includes(POSTAL_ADDRESS_LINE));
  assert.ok(m.headers['List-Unsubscribe'].includes(TOKEN));
});

test('copy: service notice has no price, no offer, no plan pitch', () => {
  const m = composeFreeReset({
    arm: 'service_notice',
    refusedDays: 2,
    resetOn: new Date('2026-12-01T00:00:00Z'),
    unsubscribeToken: TOKEN,
    pass: { endsOn: 'x', url: 'https://x.test' },
  })!;
  assert.doesNotMatch(m.text, /\$|€|Personal|upgrade|offer|paid once/i);
  assert.match(m.text, /refused on 2 days/);
  assert.match(m.text, /Unsubscribe: /);
});

test('copy: no em dash, no "30 days", no raw plan slug, no token no email', () => {
  for (const arm of ['consented', 'soft_opt_in', 'service_notice'] as const) {
    const m = composeFreeReset({ arm, refusedDays: 3, resetOn: new Date('2027-01-01T00:00:00Z'), unsubscribeToken: TOKEN })!;
    assert.doesNotMatch(m.text + m.html, /—|30 days|\bsolo\b|personal_month/);
  }
  assert.equal(composeFreeReset({ arm: 'consented', refusedDays: 3, resetOn: new Date(), unsubscribeToken: '' }), null);
});
