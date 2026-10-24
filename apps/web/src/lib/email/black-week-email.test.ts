/**
 * Tests for the Black Week 2026 email: recipient selection, the time gate,
 * the kill switch, idempotency, and what every version says.
 *
 * Nothing here touches a network. The store is in memory and enforces the
 * ledger's primary key the way ON CONFLICT DO NOTHING does.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/black-week-email.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_month';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_year';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_month_500';
process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_year_4800';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';
process.env.STRIPE_PRICE_SOLO_YEARLY = 'price_solo_year';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
delete process.env.RESEND_API_KEY;

const bw = await import('@/lib/email/black-week-email');
const tpl = await import('@/lib/email/black-week-email-template');
const { seasonalOfferFor } = await import('@/lib/stripe/seasonal-offer');
const { POSTAL_ADDRESS_LINE } = await import('@/lib/email/legal');

type Candidate = import('@/lib/email/black-week-email').Candidate;
type LedgerClaim = import('@/lib/email/black-week-email').LedgerClaim;
type OutgoingEmail = import('@/lib/email/black-week-email').OutgoingEmail;
type SubscriptionFacts = import('@/lib/email/black-week-email').SubscriptionFacts;

const SEND_TIME = new Date('2026-11-27T07:00:00.000Z');

function liveOffers(now = SEND_TIME) {
  return {
    personal: seasonalOfferFor({ planId: 'personal', interval: 'year', yearlyPriceCents: 8640, now, couponValid: true })!,
    solo: seasonalOfferFor({ planId: 'solo', interval: 'year', yearlyPriceCents: 14400, now, couponValid: true })!,
  };
}

let n = 0;
function cand(over: Partial<Candidate> = {}): Candidate {
  n += 1;
  return {
    userId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    email: `user${n}@example.test`,
    unsubscribedAt: null,
    unsubscribedCategories: [],
    unsubscribeToken: `tok-${n}`,
    marketingConsentAt: '2026-10-01T00:00:00Z',
    ownsLiveWorkspace: true,
    internal: false,
    compedGrant: false,
    billing: null,
    alreadyInLedger: false,
    ...over,
  };
}

function paid(plan: string, subId = 'sub_x', status: string | null = 'active'): Candidate['billing'] {
  return { plan, subscriptionStatus: status, stripeSubscriptionId: subId };
}

class MemoryStore {
  ledger = new Map<string, { status: string; detail: string | null; providerId?: string | null }>();
  claims: LedgerClaim[][] = [];
  candidates: Candidate[];
  constructor(candidates: Candidate[]) {
    this.candidates = candidates;
  }
  async listCandidates() {
    return this.candidates.map((c) => ({ ...c, alreadyInLedger: this.ledger.has(c.userId) }));
  }
  async claim(rows: LedgerClaim[]) {
    this.claims.push(rows);
    const won = new Set<string>();
    for (const r of rows) {
      if (this.ledger.has(r.userId)) continue;
      this.ledger.set(r.userId, { status: r.status, detail: r.detail });
      won.add(r.userId);
    }
    return won;
  }
  async finish(userId: string, outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string }) {
    const row = this.ledger.get(userId);
    if (!row || row.status !== 'claimed') return;
    row.status = outcome.status;
    if (outcome.status === 'failed') row.detail = outcome.detail;
    else row.providerId = outcome.providerId;
  }
}

function recorder(fail = false) {
  const sent: Array<{ emails: OutgoingEmail[]; key: string }> = [];
  const send = async (emails: OutgoingEmail[], key: string) => {
    sent.push({ emails, key });
    if (fail) return { ok: false as const, reason: 'provider_down' };
    return { ok: true as const, ids: emails.map((_, i) => `re_${i}`) };
  };
  return { sent, send };
}

function subs(map: Record<string, SubscriptionFacts | null>) {
  return async (id: string) => map[id] ?? null;
}

async function run(opts: {
  store: MemoryStore;
  now?: Date;
  mode?: 'send' | 'dry_run';
  offers?: Record<string, unknown>;
  send?: ReturnType<typeof recorder>['send'];
  subscriptions?: Record<string, SubscriptionFacts | null>;
}) {
  return bw.runBlackWeekEmail({
    store: opts.store,
    mode: opts.mode ?? 'send',
    now: opts.now ?? SEND_TIME,
    getOffers: async () => (opts.offers ?? liveOffers()) as never,
    send: opts.send ?? recorder().send,
    readSubscription: subs(opts.subscriptions ?? {}),
    pauseMs: 0,
  });
}

// ── Time gate ─────────────────────────────────────────────────────────────

test('time gate: nothing before 07:00 UTC on 27 Nov, everything from then, nothing after the window', () => {
  assert.equal(bw.isInSendWindow(new Date('2026-11-27T06:59:59.999Z')), false);
  assert.equal(bw.isInSendWindow(new Date('2026-11-27T07:00:00.000Z')), true);
  assert.equal(bw.isInSendWindow(new Date('2026-11-27T20:50:00.000Z')), true);
  assert.equal(bw.isInSendWindow(new Date('2026-12-01T22:59:59.000Z')), true);
  assert.equal(bw.isInSendWindow(new Date('2026-12-01T23:00:00.000Z')), false);
  assert.equal(bw.isInSendWindow(new Date('2027-11-27T07:00:00.000Z')), false);
});

test('a run before send time sends nothing and reads nobody', async () => {
  const store = new MemoryStore([cand()]);
  const rec = recorder();
  const report = await run({ store, now: new Date('2026-11-27T06:50:00Z'), send: rec.send });
  assert.equal(report.gated, 'before_send_time');
  assert.equal(rec.sent.length, 0);
  assert.equal(store.ledger.size, 0);
  assert.equal(report.candidates, 0);
});

test('a run after the window sends nothing', async () => {
  const store = new MemoryStore([cand()]);
  const rec = recorder();
  const report = await run({ store, now: new Date('2026-12-02T07:00:00Z'), send: rec.send });
  assert.equal(report.gated, 'window_closed');
  assert.equal(rec.sent.length, 0);
});

test('kill switch: no live offer (or only one) means nobody is emailed', async () => {
  for (const offers of [{}, { personal: liveOffers().personal }]) {
    const store = new MemoryStore([cand()]);
    const rec = recorder();
    const report = await run({ store, offers, send: rec.send });
    assert.equal(report.gated, 'offer_inactive');
    assert.equal(rec.sent.length, 0);
    assert.equal(store.ledger.size, 0);
  }
});

// ── Recipients ────────────────────────────────────────────────────────────

test('recipient selection: who is in and who is out', async () => {
  const free = cand();
  const lapsed = cand({ billing: paid('personal', 'sub_lapsed', 'canceled') });
  const monthlyPersonal = cand({ billing: paid('personal', 'sub_mp') });
  const monthlyPro = cand({ billing: paid('solo', 'sub_mpro') });
  const annual = cand({ billing: paid('personal', 'sub_annual') });
  const business = cand({ billing: paid('pro', 'sub_biz') });
  const team = cand({ billing: paid('team', 'sub_team') });
  const retired = cand({ billing: paid('personal', 'sub_retired') });
  const redeemed = cand({ billing: paid('solo', 'sub_redeemed') });
  const pastDue = cand({ billing: paid('personal', 'sub_pd', 'past_due') });
  const noConsent = cand({ marketingConsentAt: null });
  const unsub = cand({ unsubscribedAt: '2026-10-10T00:00:00Z' });
  const unsubLifecycle = cand({ unsubscribedCategories: ['lifecycle'] });
  const internal = cand({ internal: true });
  const member = cand({ ownsLiveWorkspace: false });
  const comped = cand({ compedGrant: true });
  const noToken = cand({ unsubscribeToken: null });

  const store = new MemoryStore([
    free, lapsed, monthlyPersonal, monthlyPro, annual, business, team, retired, redeemed, pastDue,
    noConsent, unsub, unsubLifecycle, internal, member, comped, noToken,
  ]);
  const rec = recorder();
  const report = await run({
    store,
    send: rec.send,
    subscriptions: {
      sub_mp: { status: 'active', basePriceId: 'price_personal_month', offerTag: null },
      sub_mpro: { status: 'active', basePriceId: 'price_solo_month', offerTag: null },
      sub_annual: { status: 'active', basePriceId: 'price_personal_year', offerTag: null },
      sub_retired: { status: 'active', basePriceId: 'price_personal_month_500', offerTag: null },
      sub_redeemed: { status: 'active', basePriceId: 'price_solo_month', offerTag: 'bw2026' },
      sub_pd: { status: 'past_due', basePriceId: 'price_personal_month', offerTag: null },
    },
  });

  const to = new Set(rec.sent.flatMap((b) => b.emails.map((e) => e.to)));
  assert.deepEqual(
    [...to].sort(),
    [free.email, lapsed.email, monthlyPersonal.email, monthlyPro.email].sort(),
  );
  assert.deepEqual(report.bySegment, { free: 2, monthly_personal: 1, monthly_pro: 1 });
  assert.equal(report.skipped.annual, 1);
  assert.equal(report.skipped.business_or_legacy_team, 2);
  assert.equal(report.skipped.retired_price, 1);
  assert.equal(report.skipped.already_redeemed, 1);
  assert.equal(report.skipped.not_active, 1);
  assert.equal(report.skipped.no_consent, 1);
  assert.equal(report.skipped.unsubscribed, 1);
  assert.equal(report.skipped.unsubscribed_lifecycle, 1);
  assert.equal(report.skipped.internal, 1);
  assert.equal(report.skipped.not_workspace_owner, 1);
  assert.equal(report.skipped.comped, 1);
  assert.equal(report.skipped.no_unsubscribe_token, 1);

  // Definitive exclusions are recorded so later runs skip the Stripe read.
  assert.equal(store.ledger.get(annual.userId)?.status, 'skipped');
  assert.equal(store.ledger.get(business.userId)?.status, 'skipped');
  // Transient or "never in the campaign" ones are not.
  assert.equal(store.ledger.has(pastDue.userId), false);
  assert.equal(store.ledger.has(unsub.userId), false);
});

test('a paid subscriber whose subscription cannot be read is skipped and retried next run', async () => {
  const c = cand({ billing: paid('personal', 'sub_unreadable') });
  const store = new MemoryStore([c]);
  const rec = recorder();
  const report = await run({ store, send: rec.send, subscriptions: {} });
  assert.equal(report.skipped.subscription_unreadable, 1);
  assert.equal(store.ledger.has(c.userId), false);
});

// ── Idempotency ───────────────────────────────────────────────────────────

test('exactly once: a rerun sends nothing to anyone already sent', async () => {
  const store = new MemoryStore([cand(), cand(), cand()]);
  const rec = recorder();
  const first = await run({ store, send: rec.send });
  assert.equal(first.sent, 3);
  const second = await run({ store, send: rec.send, now: new Date('2026-11-27T07:10:00Z') });
  assert.equal(second.sent, 0);
  assert.equal(second.skipped.already_in_ledger, 3);
  assert.equal(rec.sent.flatMap((b) => b.emails).length, 3);
});

test('exactly once: a lost claim is never sent', async () => {
  const c = cand();
  const store = new MemoryStore([c]);
  // Another run claimed this user between the read and the claim.
  const original = store.listCandidates.bind(store);
  store.listCandidates = async () => {
    const list = await original();
    store.ledger.set(c.userId, { status: 'claimed', detail: null });
    return list;
  };
  const rec = recorder();
  const report = await run({ store, send: rec.send });
  assert.equal(report.lostClaims, 1);
  assert.equal(rec.sent.length, 0);
});

test('a failed batch is recorded as failed and never retried', async () => {
  const store = new MemoryStore([cand(), cand()]);
  const failing = recorder(true);
  const first = await run({ store, send: failing.send });
  assert.equal(first.failed, 2);
  for (const row of store.ledger.values()) assert.equal(row.status, 'failed');
  const ok = recorder();
  const second = await run({ store, send: ok.send, now: new Date('2026-11-27T07:10:00Z') });
  assert.equal(second.sent, 0);
  assert.equal(ok.sent.length, 0);
});

test('batches of at most 100, each with a stable idempotency key', async () => {
  const many = Array.from({ length: 230 }, () => cand());
  const store = new MemoryStore(many);
  const rec = recorder();
  const report = await run({ store, send: rec.send });
  assert.equal(report.sent, 230);
  assert.deepEqual(rec.sent.map((b) => b.emails.length), [100, 100, 30]);
  const ids = rec.sent[0].emails.map((e) => e.userId);
  assert.equal(rec.sent[0].key, bw.batchIdempotencyKey([...ids].reverse()));
  assert.notEqual(rec.sent[0].key, rec.sent[1].key);
});

test('out of time stops claiming new work', async () => {
  const store = new MemoryStore(Array.from({ length: 5 }, () => cand()));
  const rec = recorder();
  const report = await bw.runBlackWeekEmail({
    store,
    mode: 'send',
    now: SEND_TIME,
    getOffers: async () => liveOffers(),
    send: rec.send,
    readSubscription: async () => null,
    outOfTime: () => true,
    pauseMs: 0,
  });
  assert.equal(report.truncated, true);
  assert.equal(report.sent, 0);
});

// ── Dry run ───────────────────────────────────────────────────────────────

test('dry run: counts by segment, writes nothing, sends nothing, works ahead of the day', async () => {
  const store = new MemoryStore([
    cand(),
    cand({ billing: paid('personal', 'sub_mp') }),
    cand({ billing: paid('solo', 'sub_annual') }),
  ]);
  const rec = recorder();
  const report = await run({
    store,
    mode: 'dry_run',
    now: new Date('2026-11-01T12:00:00Z'),
    send: rec.send,
    subscriptions: {
      sub_mp: { status: 'active', basePriceId: 'price_personal_month', offerTag: null },
      sub_annual: { status: 'active', basePriceId: 'price_solo_year', offerTag: null },
    },
  });
  assert.equal(report.mode, 'dry_run');
  assert.equal(report.gated, 'before_send_time');
  assert.deepEqual(report.bySegment, { free: 1, monthly_personal: 1, monthly_pro: 0 });
  assert.equal(report.skipped.annual, 1);
  assert.equal(store.ledger.size, 0);
  assert.equal(store.claims.length, 0);
  assert.equal(rec.sent.length, 0);
});

// ── Content ───────────────────────────────────────────────────────────────

const SEGMENTS = ['free', 'monthly_personal', 'monthly_pro'] as const;

test('every version: amounts from the live offer, renewal price beside it, end date, opt-out', () => {
  for (const segment of SEGMENTS) {
    const email = tpl.composeBlackWeekEmail({ segment, offers: liveOffers(), unsubscribeToken: 'tok-abc' })!;
    assert.ok(email, segment);
    for (const body of [email.text, email.html]) {
      assert.match(body, /1 December 2026, 23:59 Oslo time/);
      assert.match(body, /unused days of your current month are taken off/);
      assert.ok(body.includes(POSTAL_ADDRESS_LINE));
      assert.ok(body.includes('Unsubscribe'));
      assert.doesNotMatch(body, /—|–/, 'no em or en dashes');
      assert.doesNotMatch(body, /\bwas \$|hurry|last chance|only .* left/i);
    }
    assert.match(email.text, /then \$\d+(\.\d\d)? a year/);
    assert.ok(email.headers['List-Unsubscribe'].includes('tok-abc'));
    assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.doesNotMatch(email.subject, /—/);
    assert.match(email.subject, /^Black Week: /);
    // A first-year price never stands alone in a subject (no room for the
    // renewal price beside it); a saving is fine.
    assert.doesNotMatch(email.subject, /for \$\d/);
    assert.ok(email.text.includes('MCPEmails'));
  }
});

test('Free version: both plans, the switch sentence verbatim, link to annual pricing', () => {
  const email = tpl.composeBlackWeekEmail({ segment: 'free', offers: liveOffers(), unsubscribeToken: 't' })!;
  assert.equal(email.subject, 'Black Week: a lower first year on MCPEmails annual plans');
  assert.ok(email.text.includes('Personal annual is $59 for your first year, then $86.40 a year. You save $27.40.'));
  assert.ok(email.text.includes('Pro annual is $99 for your first year, then $144 a year. You save $45.'));
  assert.ok(email.text.includes(tpl.SWITCH_SENTENCE));
  assert.equal(email.ctaUrl, 'https://mcpemails.test/pricing?plan=personal&interval=year');
});

test('monthly versions lead with the switch and name their own plan', () => {
  const personal = tpl.composeBlackWeekEmail({ segment: 'monthly_personal', offers: liveOffers(), unsubscribeToken: 't' })!;
  assert.match(personal.text, /^Hi,\n\nYou pay for Personal monthly\./);
  assert.ok(personal.text.includes('you pay a bit less than $59 today'));
  assert.equal(personal.ctaUrl, 'https://mcpemails.test/dashboard/settings?upgrade=personal&interval=year');

  const pro = tpl.composeBlackWeekEmail({ segment: 'monthly_pro', offers: liveOffers(), unsubscribeToken: 't' })!;
  assert.match(pro.text, /^Hi,\n\nYou pay for Pro monthly\./);
  assert.ok(pro.text.includes('you pay a bit less than $99 today'));
  assert.ok(pro.text.includes('$144 a year. You save $45.'));
  assert.equal(pro.ctaUrl, 'https://mcpemails.test/dashboard/settings?upgrade=solo&interval=year');
  assert.equal(pro.text.includes('Personal annual'), false, 'no downgrade pitch to Pro subscribers');
});

test('no token or no live offer means no email', () => {
  assert.equal(tpl.composeBlackWeekEmail({ segment: 'free', offers: liveOffers(), unsubscribeToken: null }), null);
  assert.equal(tpl.composeBlackWeekEmail({ segment: 'free', offers: {}, unsubscribeToken: 't' }), null);
});

test('subscriptionFacts reads the base plan item and the offer tag', () => {
  const facts = bw.subscriptionFacts({
    status: 'active',
    metadata: { offer: 'bw2026' },
    items: { data: [{ price: { id: 'price_solo_month' } }] },
  });
  assert.deepEqual(facts, { status: 'active', basePriceId: 'price_solo_month', offerTag: 'bw2026' });
});
