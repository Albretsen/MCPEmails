import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decide,
  handleExpiredSession,
  isHoldout,
  recordRecovery,
  reminderMode,
  resumeUrl,
  checkoutSessionIdOrNull,
  sessionTarget,
  winningClaim,
  type ClaimInput,
  type ExpiredSession,
  type OutgoingEmail,
  type ReminderContext,
  type ReminderRow,
  type ReminderStore,
} from '@/lib/email/abandoned-checkout';
import {
  composeAbandonedCheckout,
  reminderCopy,
  reminderLocale,
  REMINDER_LOCALES,
} from '@/lib/email/abandoned-checkout-templates';

const NOW = new Date('2026-10-24T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const USER = '11111111-1111-4111-8111-111111111111';

function session(over: Partial<ExpiredSession> = {}): ExpiredSession {
  return {
    id: 'cs_test_a1B2c3D4e5F6g7H8',
    mode: 'subscription',
    status: 'expired',
    created: NOW_S - 24 * 3600,
    expiresAt: NOW_S - 60,
    locale: 'en',
    metadata: { user_id: USER, plan_id: 'personal', interval: 'month' },
    ...over,
  };
}

/** A workspace id that falls in the requested arm. */
function workspaceIn(arm: 'send' | 'holdout'): string {
  for (let i = 0; i < 1000; i++) {
    const id = `ws-${i}`;
    if (isHoldout(id) === (arm === 'holdout')) return id;
  }
  throw new Error('no workspace found');
}

function ctx(over: Partial<ReminderContext> = {}): ReminderContext {
  return {
    owner: {
      id: USER,
      email: 'buyer@example.com',
      marketingConsentAt: '2026-10-01T00:00:00Z',
      unsubscribedAt: null,
      unsubscribedCategories: [],
      unsubscribeToken: 'tok-123',
    },
    workspaceId: workspaceIn('send'),
    internal: false,
    subscriptionStatus: null,
    completedSince: false,
    rows: [],
    ...over,
  };
}

class MemoryStore implements ReminderStore {
  rows: Array<ReminderRow & { userId: string; email: string; recoveredSessionId?: string; viaLink?: boolean }> = [];
  context: ReminderContext;
  constructor(context: ReminderContext) {
    this.context = context;
  }
  async loadContext(): Promise<ReminderContext> {
    return { ...this.context, rows: await this.readRows() };
  }
  async readRows(): Promise<ReminderRow[]> {
    return this.rows.map((r) => ({ ...r }));
  }
  async claim(row: ClaimInput): Promise<boolean> {
    if (this.rows.some((r) => r.userId === row.userId && r.template === row.template && r.triggerKey === row.triggerKey)) {
      return false;
    }
    this.rows.push({
      userId: row.userId,
      email: row.email,
      template: row.template,
      triggerKey: row.triggerKey,
      status: row.status,
      detail: row.detail,
      sentAt: NOW.toISOString(),
      recoveredAt: null,
    });
    return true;
  }
  async finish(
    key: { userId: string; template: string; triggerKey: string },
    outcome: { status: 'sent' | 'failed' | 'skipped'; detail?: string; providerId?: string | null },
  ): Promise<void> {
    const row = this.rows.find((r) => r.template === key.template && r.triggerKey === key.triggerKey && r.status === 'claimed');
    if (!row) return;
    row.status = outcome.status;
    row.detail = outcome.status === 'sent' ? null : outcome.detail ?? null;
  }
  async markRecovered(
    key: { userId: string; template: string; triggerKey: string },
    recovery: { at: string; sessionId: string; viaLink: boolean },
  ): Promise<void> {
    const row = this.rows.find((r) => r.template === key.template && r.triggerKey === key.triggerKey && !r.recoveredAt);
    if (!row) return;
    row.recoveredAt = recovery.at;
    row.recoveredSessionId = recovery.sessionId;
    row.viaLink = recovery.viaLink;
  }
}

function recordingSender() {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    send: async (email: OutgoingEmail) => {
      sent.push(email);
      return { ok: true as const, id: 're_1' };
    },
  };
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

test('an eligible, consented buyer in the send arm is sent the reminder', () => {
  assert.equal(decide(session(), ctx(), NOW).kind, 'send');
});

test('the holdout arm is decided by workspace, not by session', () => {
  const holdoutCtx = ctx({ workspaceId: workspaceIn('holdout') });
  assert.equal(decide(session(), holdoutCtx, NOW).kind, 'holdout');
  assert.equal(decide(session({ id: 'cs_test_zzzzzzzzzzzz' }), holdoutCtx, NOW).kind, 'holdout');
});

test('the holdout is about 20% of workspaces', () => {
  let held = 0;
  for (let i = 0; i < 5000; i++) if (isHoldout(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)) held++;
  assert.ok(held > 900 && held < 1100, `held out ${held} of 5000`);
});

test('no marketing consent, no email', () => {
  const c = ctx();
  c.owner!.marketingConsentAt = null;
  assert.deepEqual(decide(session(), c, NOW), { kind: 'skip', reason: 'no_consent' });
});

test('unsubscribed globally or from lifecycle, no email', () => {
  const a = ctx();
  a.owner!.unsubscribedAt = '2026-10-10T00:00:00Z';
  assert.deepEqual(decide(session(), a, NOW), { kind: 'skip', reason: 'unsubscribed' });
  const b = ctx();
  b.owner!.unsubscribedCategories = ['lifecycle'];
  assert.deepEqual(decide(session(), b, NOW), { kind: 'skip', reason: 'unsubscribed_lifecycle' });
});

test('no unsubscribe token or a bad address, no email', () => {
  const a = ctx();
  a.owner!.unsubscribeToken = null;
  assert.equal(decide(session(), a, NOW).kind, 'skip');
  const b = ctx();
  b.owner!.email = 'not an address';
  assert.deepEqual(decide(session(), b, NOW), { kind: 'skip', reason: 'unusable_email' });
});

test('paid since: an entitled subscription or a completed checkout stops it', () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    assert.deepEqual(decide(session(), ctx({ subscriptionStatus: status }), NOW), { kind: 'skip', reason: 'paid_since' });
  }
  assert.deepEqual(decide(session(), ctx({ completedSince: true }), NOW), { kind: 'skip', reason: 'paid_since' });
  assert.equal(decide(session(), ctx({ subscriptionStatus: 'canceled' }), NOW).kind, 'send');
});

test('internal accounts never get it', () => {
  assert.deepEqual(decide(session(), ctx({ internal: true }), NOW), { kind: 'skip', reason: 'internal' });
});

test('one reminder per user per 30 days, holdout rows included, duplicates not', () => {
  const row = (over: Partial<ReminderRow>): ReminderRow => ({
    template: 'abandoned_checkout_solo_year',
    triggerKey: 'cs_test_older0000000',
    status: 'sent',
    detail: null,
    sentAt: '2026-10-10T00:00:00Z',
    recoveredAt: null,
    ...over,
  });
  assert.deepEqual(decide(session(), ctx({ rows: [row({})] }), NOW), { kind: 'skip', reason: 'recent_reminder' });
  assert.deepEqual(
    decide(session(), ctx({ rows: [row({ status: 'skipped', detail: 'holdout' })] }), NOW),
    { kind: 'skip', reason: 'recent_reminder' },
  );
  assert.equal(decide(session(), ctx({ rows: [row({ status: 'skipped', detail: 'duplicate' })] }), NOW).kind, 'send');
  assert.equal(decide(session(), ctx({ rows: [row({ sentAt: '2026-09-20T00:00:00Z' })] }), NOW).kind, 'send');
});

test('payment mode, missing metadata and stale replays are skipped', () => {
  assert.equal(decide(session({ mode: 'payment' }), ctx(), NOW).kind, 'skip');
  assert.deepEqual(decide(session({ metadata: { user_id: USER, plan_id: 'free', interval: 'month' } }), ctx(), NOW), {
    kind: 'skip',
    reason: 'bad_metadata',
  });
  assert.deepEqual(decide(session({ metadata: { plan_id: 'personal', interval: 'month' } }), ctx(), NOW), {
    kind: 'skip',
    reason: 'bad_metadata',
  });
  assert.deepEqual(decide(session({ expiresAt: NOW_S - 4 * 86400 }), ctx(), NOW), { kind: 'skip', reason: 'stale_event' });
});

test('the owner on the session must be the owner loaded', () => {
  const c = ctx();
  c.owner!.id = 'someone-else';
  assert.deepEqual(decide(session(), c, NOW), { kind: 'skip', reason: 'owner_missing' });
});

test('language comes from metadata.lang, then the hosted page locale, else English', () => {
  assert.equal(sessionTarget(session({ metadata: { user_id: USER, plan_id: 'solo', interval: 'year', lang: 'fr' } }))!.locale, 'fr');
  assert.equal(sessionTarget(session({ locale: 'de' }))!.locale, 'de');
  assert.equal(sessionTarget(session({ metadata: { user_id: USER, plan_id: 'solo', interval: 'year', lang: 'zh' } }))!.locale, 'en');
});

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

test('send arm: claims, sends once, marks sent; a redelivery sends nothing', async () => {
  const store = new MemoryStore(ctx());
  const s = recordingSender();
  assert.equal(await handleExpiredSession({ session: session(), store, send: s.send, mode: 'on', now: NOW }), 'sent');
  assert.equal(s.sent.length, 1);
  assert.equal(store.rows[0].status, 'sent');
  assert.equal(store.rows[0].template, 'abandoned_checkout_personal_month');
  assert.equal(store.rows[0].triggerKey, session().id);
  assert.equal(s.sent[0].idempotencyKey, `abandoned_checkout-${session().id}`);
  assert.match(s.sent[0].headers['List-Unsubscribe'], /tok-123/);

  const again = await handleExpiredSession({ session: session(), store, send: s.send, mode: 'on', now: NOW });
  assert.equal(again.startsWith('skipped') || again === 'lost_claim', true);
  assert.equal(s.sent.length, 1);
});

test('holdout arm: writes skipped/holdout and sends nothing', async () => {
  const store = new MemoryStore(ctx({ workspaceId: workspaceIn('holdout') }));
  const s = recordingSender();
  assert.equal(await handleExpiredSession({ session: session(), store, send: s.send, mode: 'on', now: NOW }), 'holdout');
  assert.equal(s.sent.length, 0);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].status, 'skipped');
  assert.equal(store.rows[0].detail, 'holdout');
});

test('off and dry_run write nothing and send nothing', async () => {
  for (const mode of ['off', 'dry_run'] as const) {
    const store = new MemoryStore(ctx());
    const s = recordingSender();
    const out = await handleExpiredSession({ session: session(), store, send: s.send, mode, now: NOW });
    assert.equal(out, mode === 'off' ? 'off' : 'would_send');
    assert.equal(store.rows.length, 0);
    assert.equal(s.sent.length, 0);
  }
});

test('a failed send is recorded and not retried', async () => {
  const store = new MemoryStore(ctx());
  let calls = 0;
  const send = async () => {
    calls++;
    return { ok: false as const, reason: 'rate_limited' };
  };
  assert.equal(await handleExpiredSession({ session: session(), store, send, mode: 'on', now: NOW }), 'failed');
  assert.equal(store.rows[0].status, 'failed');
  await handleExpiredSession({ session: session(), store, send, mode: 'on', now: NOW });
  assert.equal(calls, 1);
});

test('two sessions expiring together: only the earliest claim sends', async () => {
  const store = new MemoryStore(ctx());
  // A concurrent handler for another session already claimed, a moment earlier.
  store.rows.push({
    userId: USER,
    email: 'buyer@example.com',
    template: 'abandoned_checkout_personal_year',
    triggerKey: 'cs_test_other0000000',
    status: 'claimed',
    detail: null,
    sentAt: new Date(NOW.getTime() - 1000).toISOString(),
    recoveredAt: null,
  });
  // loadContext saw no rows yet (the race), so decide() says send.
  store.loadContext = async () => ({ ...store.context, rows: [] });
  const s = recordingSender();
  assert.equal(await handleExpiredSession({ session: session(), store, send: s.send, mode: 'on', now: NOW }), 'duplicate');
  assert.equal(s.sent.length, 0);
  assert.equal(store.rows.find((r) => r.triggerKey === session().id)!.detail, 'duplicate');
});

test('winningClaim ties break by trigger key', () => {
  const at = NOW.toISOString();
  const rows: ReminderRow[] = [
    { template: 't', triggerKey: 'cs_b', status: 'claimed', detail: null, sentAt: at, recoveredAt: null },
    { template: 't', triggerKey: 'cs_a', status: 'claimed', detail: null, sentAt: at, recoveredAt: null },
  ];
  assert.equal(winningClaim(rows, NOW)!.triggerKey, 'cs_a');
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

test('recovery credits the row the link came from, via link', async () => {
  const store = new MemoryStore(ctx());
  await handleExpiredSession({ session: session(), store, send: recordingSender().send, mode: 'on', now: NOW });
  const result = await recordRecovery({
    userId: USER,
    completedSessionId: 'cs_test_new000000000',
    recoveredFrom: session().id,
    store,
    now: NOW,
  });
  assert.equal(result, 'recovered');
  assert.equal(store.rows[0].recoveredSessionId, 'cs_test_new000000000');
  assert.equal(store.rows[0].viaLink, true);
});

test('recovery credits a holdout row too, not via link', async () => {
  const store = new MemoryStore(ctx({ workspaceId: workspaceIn('holdout') }));
  await handleExpiredSession({ session: session(), store, send: recordingSender().send, mode: 'on', now: NOW });
  await recordRecovery({ userId: USER, completedSessionId: 'cs_test_new000000000', recoveredFrom: null, store, now: NOW });
  assert.equal(store.rows[0].viaLink, false);
  assert.ok(store.rows[0].recoveredAt);
});

test('recovery ignores duplicate rows and old rows', async () => {
  const store = new MemoryStore(ctx());
  store.rows.push(
    { userId: USER, email: 'e', template: 't', triggerKey: 'cs_dup', status: 'skipped', detail: 'duplicate', sentAt: NOW.toISOString(), recoveredAt: null },
    { userId: USER, email: 'e', template: 't', triggerKey: 'cs_old', status: 'sent', detail: null, sentAt: '2026-08-01T00:00:00Z', recoveredAt: null },
  );
  assert.equal(await recordRecovery({ userId: USER, completedSessionId: 'cs_x', recoveredFrom: null, store, now: NOW }), 'none');
});

// ---------------------------------------------------------------------------
// Links, switch
// ---------------------------------------------------------------------------

test('the resume link reopens the same plan and interval and carries recovered_from', () => {
  const url = new URL(resumeUrl('solo', 'year', 'nb', 'cs_test_a1B2c3D4e5F6g7H8'));
  assert.equal(url.pathname, '/api/stripe/checkout/start');
  assert.equal(url.searchParams.get('plan'), 'solo');
  assert.equal(url.searchParams.get('interval'), 'year');
  assert.equal(url.searchParams.get('lang'), 'nb');
  assert.equal(url.searchParams.get('recovered_from'), 'cs_test_a1B2c3D4e5F6g7H8');
  assert.equal(new URL(resumeUrl('personal', 'month', 'en', 'cs_test_a1B2c3D4e5F6g7H8')).searchParams.has('lang'), false);
});

test('recovered_from must look like a Checkout session id', () => {
  assert.equal(checkoutSessionIdOrNull('cs_live_a1B2c3D4e5F6g7H8'), 'cs_live_a1B2c3D4e5F6g7H8');
  for (const bad of ['', 'cs_live_', 'pi_123456789', 'cs_live_abc<script>', 42, null, ['cs_live_a1B2c3D4e5F6g7H8']]) {
    assert.equal(checkoutSessionIdOrNull(bad), null);
  }
});

test('the switch defaults to on, off and dry_run are explicit', () => {
  assert.equal(reminderMode({}), 'on');
  assert.equal(reminderMode({ ABANDONED_CHECKOUT_EMAIL: 'off' }), 'off');
  assert.equal(reminderMode({ ABANDONED_CHECKOUT_EMAIL: ' DRY_RUN ' }), 'dry_run');
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('every locale composes, with the refund line, opt-out and postal line, and nothing banned', () => {
  for (const locale of REMINDER_LOCALES) {
    const c = composeAbandonedCheckout({
      planId: 'personal',
      interval: 'month',
      locale,
      resumeUrl: 'https://mcpemails.com/api/stripe/checkout/start?plan=personal&interval=month',
      unsubscribeToken: 'tok-123',
    });
    assert.ok(c, locale);
    const all = `${c.subject}\n${c.text}\n${c.html}`;
    const words = `${c.subject}\n${c.text}`;
    assert.match(c.text, /14/, `${locale} refund line`);
    assert.doesNotMatch(all, /30 (days|dager|días|jours|Tage)/i, `${locale} says 30 days`);
    assert.doesNotMatch(all, /—/, `${locale} em dash`);
    assert.doesNotMatch(all, /MCP Emails/, `${locale} brand`);
    assert.doesNotMatch(words, /%|discount|rabatt|descuento|réduction|remise|Rabatt|coupon|promo/i, `${locale} discount`);
    assert.doesNotMatch(words, /\$\d|USD|expire|utløp|caduc|expir|abläuft|hurry|last chance/i, `${locale} price or urgency`);
    assert.match(c.text, /Personal/);
    assert.match(c.text, /api\/email\/unsubscribe\?token=tok-123&c=lifecycle/);
    assert.match(c.text, /organisation number/);
    assert.equal(c.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(c.html, new RegExp(`<html lang="${locale}">`));
  }
});

test('locales differ from English (no untranslated copy)', () => {
  const en = reminderCopy('en');
  for (const locale of REMINDER_LOCALES.filter((l) => l !== 'en')) {
    const c = reminderCopy(locale);
    for (const key of ['help', 'refund', 'cta', 'footerNote', 'unsubscribeReason', 'notAffected'] as const) {
      assert.notEqual(c[key], en[key], `${locale}.${key}`);
    }
  }
});

test('the interval is named, plan comes from the catalogue', () => {
  const c = composeAbandonedCheckout({
    planId: 'solo',
    interval: 'year',
    locale: 'en',
    resumeUrl: 'https://mcpemails.com/x',
    unsubscribeToken: 'tok',
  })!;
  assert.match(c.text, /MCPEmails Pro, billed yearly/);
  assert.equal(c.subject, 'Your MCPEmails Pro checkout');
});

test('no token, no email', () => {
  assert.equal(
    composeAbandonedCheckout({ planId: 'personal', interval: 'month', locale: 'en', resumeUrl: 'x', unsubscribeToken: null }),
    null,
  );
});

test('reminderLocale allow-lists', () => {
  assert.equal(reminderLocale('fr'), 'fr');
  assert.equal(reminderLocale('zh'), 'en');
  assert.equal(reminderLocale('FR'), 'en');
  assert.equal(reminderLocale(undefined), 'en');
});
