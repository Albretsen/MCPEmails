/**
 * Tests for the first-30-days retention loop: M2 (stuck-note draft for
 * Asgeir) and M3 (day-8 week-1 summary with a 50% holdout).
 *
 * NOTHING HERE TOUCHES A NETWORK, A DATABASE OR A MAILBOX. The store is the
 * in-memory MemoryStore below, which enforces the ledger's primary key
 * (user_id, template, trigger_key) the way ON CONFLICT DO NOTHING does; the
 * sender and the draft writer record what they were handed.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/retention/first-30-days.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
delete process.env.RESEND_API_KEY;

const f30 = await import('@/lib/retention/first-30-days');
const tpl = await import('@/lib/retention/first-30-days-templates');
const draftMod = await import('@/lib/retention/first-30-days-draft');
const storeMod = await import('@/lib/retention/first-30-days-store');
const { LIFECYCLE_CATEGORIES } = await import('@/lib/email/lifecycle');
const { POSTAL_ADDRESS_LINE } = await import('@/lib/email/legal');

type Ctx = import('@/lib/retention/first-30-days').CandidateContext;
type ClaimRow = import('@/lib/retention/first-30-days').ClaimRow;
type FirstPayment = import('@/lib/retention/first-30-days').FirstPayment;
type StuckDetails = import('@/lib/retention/first-30-days').StuckDetails;
type Week1Stats = import('@/lib/retention/first-30-days').Week1Stats;
type OutgoingEmail = import('@/lib/retention/first-30-days').OutgoingEmail;
type StuckDraft = import('@/lib/retention/first-30-days').StuckDraft;
type FinishOutcome = import('@/lib/retention/first-30-days').FinishOutcome;

const { HOUR, DAY, TEMPLATE_STUCK, TEMPLATE_WEEK1, decideStuck, decideWeek1, week1Gate, runFirst30 } = f30;

const START = new Date('2026-10-25T00:00:00.000Z');
const START_MS = START.getTime();
const T0 = new Date('2026-11-02T14:30:00.000Z'); // first payment
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const WS = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER = '00000000-0000-4000-8000-0000000000aa';
const TOKEN = '11111111-2222-4333-8444-555555555555';
const EM_DASH = String.fromCharCode(0x2014);

function ctx(overrides: Partial<Ctx> = {}, owner: Partial<NonNullable<Ctx['owner']>> = {}): Ctx {
  return {
    workspaceId: WS,
    firstPaidAt: T0.toISOString(),
    workspace: { ownerId: USER, deletedAt: null },
    owner: {
      id: USER,
      email: 'owner@example.test',
      displayName: 'Kari Nordmann',
      unsubscribedAt: null,
      unsubscribedCategories: [],
      unsubscribeToken: TOKEN,
      ...owner,
    },
    subscriptionStatus: 'active',
    internal: false,
    successSincePaid: 0,
    ledger: [],
    ...overrides,
  };
}

function stats(overrides: Partial<Week1Stats> = {}): Week1Stats {
  return {
    counts: { search: 12, opened: 30, drafts: 4, sent: 2, scheduled: 1 },
    totalSuccess: 49,
    activeDays: 5,
    automationsSorted: 0,
    hasAutomation: false,
    inboxAddresses: ['me@example.test'],
    ...overrides,
  };
}

const DETAILS: StuckDetails = {
  totalCalls: 6,
  topErrorCodes: [{ code: 'auth_failed', count: 5 }, { code: 'provider_error', count: 1 }],
  clientNames: ['claude-ai'],
  inboxProviders: ['imap'],
};

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

class MemoryStore {
  firsts: FirstPayment[];
  contexts = new Map<string, Ctx>();
  ledger = new Map<string, { status: string; detail: string | null; providerId?: string | null }>();
  claims: ClaimRow[] = [];
  assignments = new Map<string, string>();
  experimentUp = true;
  details: StuckDetails = DETAILS;
  week1: Week1Stats = stats();
  writes = 0;

  constructor(contexts: Ctx[]) {
    this.firsts = contexts.map((c) => ({ workspaceId: c.workspaceId, firstPaidAt: c.firstPaidAt }));
    for (const c of contexts) this.contexts.set(c.workspaceId, c);
  }

  private key(userId: string, template: string, ws: string) {
    return `${userId}|${template}|${ws}`;
  }

  async listFirstPayments(since: Date) {
    return this.firsts.filter((f) => new Date(f.firstPaidAt).getTime() >= since.getTime());
  }

  async loadContexts(firsts: FirstPayment[]) {
    return firsts.map((f) => {
      const c = this.contexts.get(f.workspaceId)!;
      const ledger = [...this.ledger.entries()]
        .filter(([k]) => k.endsWith(`|${f.workspaceId}`))
        .map(([k, v]) => ({
          template: k.split('|')[1],
          triggerKey: f.workspaceId,
          status: v.status,
          detail: v.detail,
          sentAt: T0.toISOString(),
          finishedAt: null,
        }));
      return { ...c, ledger };
    });
  }

  async loadStuckDetails() {
    return this.details;
  }

  async loadWeek1Stats() {
    return this.week1;
  }

  async assignVariant(workspaceId: string, proposed: string) {
    if (!this.experimentUp) return null;
    this.writes += 1;
    if (!this.assignments.has(workspaceId)) this.assignments.set(workspaceId, proposed);
    return this.assignments.get(workspaceId)!;
  }

  async claim(row: ClaimRow) {
    this.writes += 1;
    this.claims.push(row);
    const k = this.key(row.userId, row.template, row.workspaceId);
    if (this.ledger.has(k)) return false;
    this.ledger.set(k, { status: row.status, detail: row.detail });
    return true;
  }

  async finish(key: { userId: string; workspaceId: string; template: string }, outcome: FinishOutcome) {
    this.writes += 1;
    const k = this.key(key.userId, key.template, key.workspaceId);
    const row = this.ledger.get(k);
    if (row && row.status === 'claimed') {
      this.ledger.set(k, {
        status: outcome.status,
        detail: outcome.detail,
        providerId: outcome.status === 'sent' ? outcome.providerId : null,
      });
    }
  }
}

function recorders() {
  const emails: OutgoingEmail[] = [];
  const drafts: StuckDraft[] = [];
  return {
    emails,
    drafts,
    send: async (e: OutgoingEmail) => {
      emails.push(e);
      return { ok: true as const, id: `re_${emails.length}` };
    },
    writeDraft: async (d: StuckDraft) => {
      drafts.push(d);
      return { ok: true as const, via: 'imap_draft', id: 'msg-1' };
    },
  };
}

/** A workspace id whose hash lands in the wanted arm. */
function wsInArm(arm: string): string {
  for (let i = 0; i < 1000; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (f30.proposedVariant(id) === arm) return id;
  }
  throw new Error('no id found');
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

test('pickFirstPayments keeps the first checkout per workspace and drops ones with an earlier payment', () => {
  const rows = [
    { workspace_id: 'a', occurred_at: '2026-11-03T00:00:00Z' },
    { workspace_id: 'a', occurred_at: '2026-11-01T00:00:00Z' },
    { workspace_id: 'b', occurred_at: '2026-11-02T00:00:00Z' },
  ];
  const out = f30.pickFirstPayments(rows, new Set(['b']));
  assert.deepEqual(out, [{ workspaceId: 'a', firstPaidAt: '2026-11-01T00:00:00Z' }]);
});

// ---------------------------------------------------------------------------
// Shared eligibility
// ---------------------------------------------------------------------------

test('shared eligibility: every rule', () => {
  const s = (c: Ctx) => f30.sharedIneligibility(c, START_MS);
  assert.equal(s(ctx()), null);
  assert.equal(s(ctx({ firstPaidAt: '2026-10-20T00:00:00Z' })), 'before_go_live');
  assert.equal(s(ctx({ workspace: null })), 'workspace_missing');
  assert.equal(s(ctx({ workspace: { ownerId: USER, deletedAt: T0.toISOString() } })), 'workspace_deleted');
  assert.equal(s(ctx({ workspace: { ownerId: 'someone-else', deletedAt: null } })), 'owner_missing');
  assert.equal(s(ctx({ owner: null })), 'owner_missing');
  assert.equal(s(ctx({ internal: true })), 'internal');
  assert.equal(s(ctx({ subscriptionStatus: null })), 'not_subscribed');
  assert.equal(s(ctx({ subscriptionStatus: 'canceled' })), 'not_subscribed');
  assert.equal(s(ctx({ subscriptionStatus: 'past_due' })), 'not_subscribed');
  assert.equal(s(ctx({ subscriptionStatus: 'trialing' })), null);
  assert.equal(s(ctx({}, { email: 'not-an-address' })), 'unusable_email');
  assert.equal(s(ctx({}, { email: 'a@b.test\r\nBcc: x@y.test' })), 'unusable_email');
  assert.equal(s(ctx({}, { email: null })), 'unusable_email');
});

// ---------------------------------------------------------------------------
// M2
// ---------------------------------------------------------------------------

test('M2 waits until 72 hours after the first payment', () => {
  const d = decideStuck(ctx(), at(71 * HOUR), START_MS);
  assert.equal(d.kind, 'wait');
  assert.equal(d.kind === 'wait' && d.dueAt, at(72 * HOUR).toISOString());
});

test('M2 is due at 72 hours with zero successful calls since paying', () => {
  assert.deepEqual(decideStuck(ctx(), at(72 * HOUR), START_MS), { kind: 'send' });
});

test('M2 stops when there was a successful call, and past day 7', () => {
  assert.deepEqual(decideStuck(ctx({ successSincePaid: 1 }), at(80 * HOUR), START_MS), { kind: 'stop', reason: 'not_stuck' });
  assert.deepEqual(decideStuck(ctx(), at(7 * DAY + 1), START_MS), { kind: 'stop', reason: 'window_missed' });
});

test('M2 still goes to day-0 cancellers and ignores email opt-outs (it is a 1:1 draft, not a send)', () => {
  const c = ctx({}, { unsubscribedAt: T0.toISOString(), unsubscribedCategories: ['activity_summary'], unsubscribeToken: null });
  assert.deepEqual(decideStuck(c, at(73 * HOUR), START_MS), { kind: 'send' });
});

test('M2 respects the shared rules and the ledger', () => {
  assert.deepEqual(decideStuck(ctx({ internal: true }), at(73 * HOUR), START_MS), { kind: 'stop', reason: 'internal' });
  assert.deepEqual(decideStuck(ctx({ subscriptionStatus: 'canceled' }), at(73 * HOUR), START_MS), {
    kind: 'stop',
    reason: 'not_subscribed',
  });
  const done = ctx({
    ledger: [{ template: TEMPLATE_STUCK, triggerKey: WS, status: 'failed', detail: 'x', sentAt: '', finishedAt: null }],
  });
  assert.deepEqual(decideStuck(done, at(73 * HOUR), START_MS), { kind: 'done', status: 'failed' });
});

test('M2 never acts on a payment before go-live', () => {
  const old = ctx({ firstPaidAt: '2026-10-24T12:00:00Z' });
  assert.deepEqual(decideStuck(old, new Date('2026-10-28T00:00:00Z'), START_MS), { kind: 'stop', reason: 'before_go_live' });
});

// ---------------------------------------------------------------------------
// M3
// ---------------------------------------------------------------------------

test('M3 is due at the first 09:00 UTC on or after day 8, and sends until day 10', () => {
  // T0 is 14:30 UTC, so day 8 is 14:30 and the next 09:00 is the morning after.
  const due = f30.nextSendHour(T0.getTime() + 8 * DAY);
  assert.equal(new Date(due).toISOString(), '2026-11-11T09:00:00.000Z');
  assert.equal(decideWeek1(ctx(), new Date(due - 1), START_MS).kind, 'wait');
  assert.deepEqual(decideWeek1(ctx(), new Date(due), START_MS), { kind: 'send' });
  assert.deepEqual(decideWeek1(ctx(), at(10 * DAY), START_MS), { kind: 'send' });
  assert.deepEqual(decideWeek1(ctx(), at(10 * DAY + 1), START_MS), { kind: 'stop', reason: 'window_missed' });
});

test('nextSendHour keeps 09:00 exactly and moves anything later to the next day', () => {
  assert.equal(new Date(f30.nextSendHour(Date.parse('2026-11-10T09:00:00Z'))).toISOString(), '2026-11-10T09:00:00.000Z');
  assert.equal(new Date(f30.nextSendHour(Date.parse('2026-11-10T03:00:00Z'))).toISOString(), '2026-11-10T09:00:00.000Z');
  assert.equal(new Date(f30.nextSendHour(Date.parse('2026-11-10T09:00:01Z'))).toISOString(), '2026-11-11T09:00:00.000Z');
});

test('M3 checks the opt-outs but not marketing consent', () => {
  const now = at(9 * DAY);
  assert.deepEqual(decideWeek1(ctx({}, { unsubscribedAt: T0.toISOString() }), now, START_MS), { kind: 'stop', reason: 'unsubscribed' });
  assert.deepEqual(decideWeek1(ctx({}, { unsubscribedCategories: ['activity_summary'] }), now, START_MS), {
    kind: 'stop',
    reason: 'unsubscribed_activity_summary',
  });
  assert.deepEqual(decideWeek1(ctx({}, { unsubscribeToken: null }), now, START_MS), { kind: 'stop', reason: 'no_unsubscribe_token' });
  // A different category does not stop it, and there is no consent field at all.
  assert.deepEqual(decideWeek1(ctx({}, { unsubscribedCategories: ['lifecycle'] }), now, START_MS), { kind: 'send' });
});

test('M3 respects the shared rules, day-0 cancellers still get it, and the ledger ends it', () => {
  const now = at(9 * DAY);
  assert.deepEqual(decideWeek1(ctx({ workspace: { ownerId: USER, deletedAt: T0.toISOString() } }), now, START_MS), {
    kind: 'stop',
    reason: 'workspace_deleted',
  });
  assert.deepEqual(decideWeek1(ctx({ subscriptionStatus: 'trialing' }), now, START_MS), { kind: 'send' });
  const held = ctx({
    ledger: [{ template: TEMPLATE_WEEK1, triggerKey: WS, status: 'skipped', detail: 'holdout', sentAt: '', finishedAt: null }],
  });
  assert.deepEqual(decideWeek1(held, now, START_MS), { kind: 'done', status: 'skipped' });
});

test('M3 needs at least one successful call in week 1', () => {
  assert.equal(week1Gate(stats({ totalSuccess: 0 })), 'no_week1_activity');
  assert.equal(week1Gate(stats({ totalSuccess: 1 })), null);
});

// ---------------------------------------------------------------------------
// Holdout
// ---------------------------------------------------------------------------

test('holdout assignment is deterministic per workspace and close to 50/50', () => {
  assert.equal(f30.proposedVariant(WS), f30.proposedVariant(WS));
  assert.match(f30.subjectIdFor(WS), /^[a-f0-9]{32}$/);
  let summary = 0;
  for (let i = 0; i < 2000; i += 1) {
    const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const v = f30.proposedVariant(id);
    assert.ok(v === 'holdout' || v === 'summary');
    if (v === 'summary') summary += 1;
  }
  assert.ok(summary > 850 && summary < 1150, `summary arm ${summary} of 2000`);
});

test('the variants in code match the experiment row in the migration', () => {
  const sql = readMigration();
  for (const v of f30.HOLDOUT_VARIANTS) {
    assert.ok(sql.includes(`{"id":"${v.id}","label":"${v.label}","weight":${v.weight}}`), v.id);
  }
  assert.ok(sql.includes(`'${f30.HOLDOUT_EXPERIMENT_KEY}'`));
});

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

test('dry run decides and reports but writes, drafts and sends nothing', async () => {
  const now = at(10 * DAY);
  const stuck = ctx({ workspaceId: 'aaaaaaaa-0000-4000-8000-000000000001', firstPaidAt: new Date(now.getTime() - 80 * HOUR).toISOString() });
  const week = ctx({ workspaceId: 'aaaaaaaa-0000-4000-8000-000000000002', firstPaidAt: new Date(now.getTime() - 9 * DAY).toISOString() });
  const store = new MemoryStore([stuck, week]);
  const r = recorders();
  const report = await runFirst30({ store, mode: 'dry_run', now, startAt: START, send: r.send, writeDraft: r.writeDraft });
  assert.equal(store.writes, 0);
  assert.equal(r.emails.length, 0);
  assert.equal(r.drafts.length, 0);
  assert.equal(report.wouldDraft, 1);
  assert.equal(report.wouldSend + report.wouldHoldout, 1);
  const json = JSON.stringify(report);
  assert.ok(!json.includes('@'), 'no addresses in the report');
  assert.ok(json.includes(stuck.workspaceId));
});

test('send mode: M2 drafts once, to the owner, and is not repeated', async () => {
  const store = new MemoryStore([ctx()]);
  const r = recorders();
  const opts = { store, mode: 'send' as const, now: at(73 * HOUR), startAt: START, send: r.send, writeDraft: r.writeDraft };
  const first = await runFirst30(opts);
  assert.equal(first.drafted, 1);
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0].to, 'owner@example.test');
  assert.equal(r.drafts[0].note.subject, 'Your MCPEmails setup');
  assert.equal(r.emails.length, 0, 'nothing is emailed to the customer');
  const row = store.ledger.get(`${USER}|${TEMPLATE_STUCK}|${WS}`);
  assert.equal(row?.status, 'sent');
  assert.equal(row?.detail, 'imap_draft');

  const second = await runFirst30(opts);
  assert.equal(second.drafted, 0);
  assert.equal(r.drafts.length, 1);
});

test('send mode: a failed M2 draft is recorded and never retried', async () => {
  const store = new MemoryStore([ctx()]);
  const r = recorders();
  const failing = async () => ({ ok: false as const, reason: 'draft_inbox_not_found; no_api_key' });
  const opts = { store, mode: 'send' as const, now: at(73 * HOUR), startAt: START, send: r.send, writeDraft: failing };
  const first = await runFirst30(opts);
  assert.equal(first.failed, 1);
  assert.equal(store.ledger.get(`${USER}|${TEMPLATE_STUCK}|${WS}`)?.status, 'failed');
  const second = await runFirst30(opts);
  assert.equal(second.failed, 0);
  assert.equal(second.done, 1);
});

test('send mode: M3 summary arm gets the email with one-click headers', async () => {
  const id = wsInArm('summary');
  const store = new MemoryStore([ctx({ workspaceId: id })]);
  const r = recorders();
  const report = await runFirst30({ store, mode: 'send', now: at(9 * DAY), startAt: START, send: r.send, writeDraft: r.writeDraft });
  assert.equal(report.sent, 1);
  assert.equal(r.emails.length, 1);
  const e = r.emails[0];
  assert.equal(e.to, 'owner@example.test');
  assert.equal(e.subject, 'Your first week with MCPEmails');
  assert.equal(e.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(e.headers['List-Unsubscribe'].includes('c=activity_summary'));
  assert.equal(e.idempotencyKey, `${TEMPLATE_WEEK1}-${id}`);
  assert.equal(store.assignments.get(id), 'summary');
});

test('send mode: M3 holdout gets nothing and is recorded once', async () => {
  const id = wsInArm('holdout');
  const store = new MemoryStore([ctx({ workspaceId: id })]);
  const r = recorders();
  const opts = { store, mode: 'send' as const, now: at(9 * DAY), startAt: START, send: r.send, writeDraft: r.writeDraft };
  const report = await runFirst30(opts);
  assert.equal(report.holdout, 1);
  assert.equal(r.emails.length, 0);
  const row = store.ledger.get(`${USER}|${TEMPLATE_WEEK1}|${id}`);
  assert.deepEqual(row, { status: 'skipped', detail: 'holdout' });
  const again = await runFirst30(opts);
  assert.equal(again.holdout, 0);
  assert.equal(r.emails.length, 0);
});

test('send mode: the stored assignment wins over the local hash', async () => {
  const id = wsInArm('summary');
  const store = new MemoryStore([ctx({ workspaceId: id })]);
  store.assignments.set(id, 'holdout');
  const r = recorders();
  await runFirst30({ store, mode: 'send', now: at(9 * DAY), startAt: START, send: r.send, writeDraft: r.writeDraft });
  assert.equal(r.emails.length, 0);
});

test('send mode: an unreadable experiment fails closed', async () => {
  const store = new MemoryStore([ctx({ workspaceId: wsInArm('summary') })]);
  store.experimentUp = false;
  const r = recorders();
  const report = await runFirst30({ store, mode: 'send', now: at(9 * DAY), startAt: START, send: r.send, writeDraft: r.writeDraft });
  assert.equal(r.emails.length, 0);
  assert.equal(report.stopped.experiment_unavailable, 1);
  assert.equal(store.claims.length, 0);
});

test('send mode: no week-1 activity means no M3 and no assignment', async () => {
  const store = new MemoryStore([ctx({ workspaceId: wsInArm('summary') })]);
  store.week1 = stats({ totalSuccess: 0, counts: { search: 0, opened: 0, drafts: 0, sent: 0, scheduled: 0 } });
  const r = recorders();
  const report = await runFirst30({ store, mode: 'send', now: at(9 * DAY), startAt: START, send: r.send, writeDraft: r.writeDraft });
  assert.equal(r.emails.length, 0);
  assert.equal(store.assignments.size, 0);
  assert.equal(report.stopped.no_week1_activity, 1);
});

test('send mode: eligibility is re-read right before acting', async () => {
  const store = new MemoryStore([ctx()]);
  const r = recorders();
  const original = store.loadContexts.bind(store);
  let calls = 0;
  store.loadContexts = async (firsts: FirstPayment[]) => {
    calls += 1;
    const out = await original(firsts);
    // The second read (the re-check) sees the subscription gone.
    return calls > 1 ? out.map((c) => ({ ...c, subscriptionStatus: 'canceled' })) : out;
  };
  const report = await runFirst30({ store, mode: 'send', now: at(73 * HOUR), startAt: START, send: r.send, writeDraft: r.writeDraft });
  assert.equal(r.drafts.length, 0);
  assert.equal(report.stopped.not_subscribed, 1);
});

test('send mode: stops at maxActions', async () => {
  const contexts = [1, 2, 3].map((n) =>
    ctx({ workspaceId: `bbbbbbbb-0000-4000-8000-00000000000${n}`, firstPaidAt: at(-(73 + n) * HOUR).toISOString() }),
  );
  const store = new MemoryStore(contexts);
  const r = recorders();
  const report = await runFirst30({ store, mode: 'send', now: T0, startAt: START, send: r.send, writeDraft: r.writeDraft, maxActions: 2 });
  assert.equal(report.drafted, 2);
  assert.equal(report.truncated, true);
});

test('payments before go-live are never read', async () => {
  const store = new MemoryStore([ctx({ firstPaidAt: '2026-10-24T20:00:00Z' })]);
  const r = recorders();
  const report = await runFirst30({
    store,
    mode: 'send',
    now: new Date('2026-10-28T00:00:00Z'),
    startAt: START,
    send: r.send,
    writeDraft: r.writeDraft,
  });
  assert.equal(report.candidates, 0);
  assert.equal(r.drafts.length, 0);
});

test('send mode refuses to run without both senders', async () => {
  await assert.rejects(runFirst30({ store: new MemoryStore([]), mode: 'send', send: recorders().send }));
});

test('listStuckPayers shows zero-success payers with their draft status', async () => {
  const waiting = ctx({ workspaceId: 'cccccccc-0000-4000-8000-000000000001', firstPaidAt: at(-10 * HOUR).toISOString() });
  const fine = ctx({ workspaceId: 'cccccccc-0000-4000-8000-000000000002', successSincePaid: 4 });
  const internal = ctx({ workspaceId: 'cccccccc-0000-4000-8000-000000000003', internal: true });
  const store = new MemoryStore([waiting, fine, internal]);
  const rows = await f30.listStuckPayers(store, T0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'waiting');
  assert.deepEqual(rows[0].topErrorCodes, DETAILS.topErrorCodes);
});

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

test('switches fail towards silence', () => {
  assert.equal(f30.first30Mode({}), 'off');
  assert.equal(f30.first30Mode({ FIRST30_ENABLED: 'yes' }), 'off');
  assert.equal(f30.first30Mode({ FIRST30_ENABLED: 'on' }), 'dry_run');
  assert.equal(f30.first30Mode({ FIRST30_ENABLED: 'on', FIRST30_DRY_RUN: 'flase' }), 'dry_run');
  assert.equal(f30.first30Mode({ FIRST30_ENABLED: 'true', FIRST30_DRY_RUN: 'false' }), 'send');
  assert.equal(f30.first30StartAt({}).toISOString(), f30.DEFAULT_START_AT);
  assert.equal(f30.first30StartAt({ FIRST30_START_AT: 'nope' }).toISOString(), f30.DEFAULT_START_AT);
  assert.equal(f30.first30StartAt({ FIRST30_START_AT: '2026-11-01T00:00:00Z' }).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(f30.first30MaxPerRun({ FIRST30_MAX_PER_RUN: '500' }), 100);
  assert.equal(f30.first30DraftMailbox({}), 'asgeir@mcpemails.com');
});

// ---------------------------------------------------------------------------
// Templates: M3
// ---------------------------------------------------------------------------

function week1(overrides: Partial<Parameters<typeof tpl.composeWeek1Summary>[0]> = {}) {
  return tpl.composeWeek1Summary({
    firstName: 'Kari',
    from: T0.toISOString(),
    to: at(7 * DAY - 1).toISOString(),
    counts: { search: 12, opened: 30, drafts: 4, sent: 2, scheduled: 1 },
    automationsSorted: 0,
    inboxAddresses: ['me@example.test'],
    totalCalls: 49,
    activeDays: 5,
    hasAutomation: false,
    unsubscribeToken: TOKEN,
    ...overrides,
  });
}

function assertCleanCopy(text: string) {
  assert.ok(!text.includes(EM_DASH), 'no em dash');
  assert.ok(!/30 days/i.test(text), 'never "30 days"');
  assert.ok(!/\$\d|€\d|\bkr\b/.test(text), 'no prices');
  assert.ok(!/action cap|actions a month|personal plan|pro plan|\bsolo\b/i.test(text), 'no cap or plan names');
  assert.ok(!/MCP Emails/.test(text), 'product name is one word');
  assert.ok(!/saved you|hours saved|minutes saved/i.test(text), 'never estimates time saved');
}

test('M3 renders every non-zero line, the dates, the opt-out and the postal line', () => {
  const e = week1()!;
  assert.ok(e.text.startsWith('Hi Kari,'));
  assert.ok(e.text.includes('from 2 November 2026 to 9 November 2026'));
  assert.ok(e.text.includes('- Searched your mail 12 times and opened 30 emails'));
  assert.ok(e.text.includes('- Wrote 4 drafts and sent 2 emails'));
  assert.ok(e.text.includes('- Scheduled 1 email'));
  assert.ok(e.text.includes('- Connected inboxes: me@example.test'));
  assert.ok(!e.text.includes('automations sorted'));
  assert.ok(e.text.includes(`Stop these activity summaries: https://mcpemails.test/api/email/unsubscribe?token=${TOKEN}&c=activity_summary`));
  assert.ok(e.text.includes(POSTAL_ADDRESS_LINE));
  assert.ok(e.html.includes('Stop these activity summaries'));
  assert.ok(e.html.includes('c=activity_summary'));
  assert.ok(!/<img/i.test(e.html), 'no images');
  assertCleanCopy(e.text);
  assertCleanCopy(e.html);
});

test('M3 omits zero lines and joins half lines correctly', () => {
  const e = week1({ counts: { search: 0, opened: 1, drafts: 3, sent: 0, scheduled: 0 }, automationsSorted: 17, inboxAddresses: [] })!;
  assert.ok(e.text.includes('- Opened 1 email\n'));
  assert.ok(e.text.includes('- Wrote 3 drafts\n'));
  assert.ok(e.text.includes('- Your automations sorted 17 messages on their own'));
  assert.ok(!e.text.includes('Searched'));
  assert.ok(!e.text.includes('Scheduled'));
  assert.ok(!e.text.includes('Connected inboxes'));
  assert.ok(!e.text.includes(' 0 '));
  assert.deepEqual(tpl.week1Lines({ counts: { search: 1, opened: 0, drafts: 0, sent: 2, scheduled: 0 }, automationsSorted: 0, inboxAddresses: [] }), [
    'Searched your mail once',
    'Sent 2 emails',
  ]);
});

test('M3 tip logic: automation tip, then daily tip, suppressed at 100 calls', () => {
  assert.equal(tpl.week1Tip({ totalCalls: 10, activeDays: 1, hasAutomation: false }), 'automation');
  assert.equal(tpl.week1Tip({ totalCalls: 10, activeDays: 2, hasAutomation: true }), 'daily');
  assert.equal(tpl.week1Tip({ totalCalls: 10, activeDays: 3, hasAutomation: true }), null);
  assert.equal(tpl.week1Tip({ totalCalls: 100, activeDays: 1, hasAutomation: false }), null);
  assert.equal(tpl.week1Tip({ totalCalls: 99, activeDays: 1, hasAutomation: false }), 'automation');

  const auto = week1({ hasAutomation: false })!;
  assert.equal(auto.tip, 'automation');
  assert.ok(auto.text.includes('"Every hour, move newsletters from me@example.test to a folder called Later."'));
  const daily = week1({ hasAutomation: true, activeDays: 2 })!;
  assert.ok(daily.text.includes('"What needs a reply today?"'));
  const heavy = week1({ totalCalls: 250 })!;
  assert.equal(heavy.tip, null);
  assert.ok(!heavy.text.includes('Ask your assistant'));
  assert.ok(!heavy.text.includes('One to try tomorrow'));
});

test('M3 is not composed without an unsubscribe token or without any line', () => {
  assert.equal(week1({ unsubscribeToken: null }), null);
  assert.equal(week1({ unsubscribeToken: '  ' }), null);
  assert.equal(
    week1({ counts: { search: 0, opened: 0, drafts: 0, sent: 0, scheduled: 0 }, automationsSorted: 0, inboxAddresses: [] }),
    null,
  );
});

test('M3 greeting falls back to plain "Hi," when the name is not a name', () => {
  assert.equal(tpl.firstNameFrom('Kari Nordmann'), 'Kari');
  assert.equal(tpl.firstNameFrom('kari@example.test'), null);
  assert.equal(tpl.firstNameFrom('user123'), null);
  assert.equal(tpl.firstNameFrom(null), null);
  assert.ok(week1({ firstName: null })!.text.startsWith('Hi,\n'));
});

test('M3 escapes HTML in addresses', () => {
  const e = week1({ inboxAddresses: ['<b>x</b>@example.test'] })!;
  assert.ok(!e.html.includes('<b>x</b>'));
  assert.ok(e.html.includes('&lt;b&gt;'));
});

// ---------------------------------------------------------------------------
// Templates: M2
// ---------------------------------------------------------------------------

test('M2 note with errors names them in plain language with a fix line', () => {
  const note = tpl.composeStuckNote({ firstName: 'Kari', paidAt: T0.toISOString(), ...DETAILS });
  assert.equal(note.subject, 'Your MCPEmails setup');
  assert.ok(note.text.startsWith('Hi Kari,'));
  assert.ok(note.text.includes('since you subscribed on 2 November 2026'));
  assert.ok(note.text.includes('The last attempts failed with: the mail server rejected the password; your mail provider returned an error.'));
  assert.ok(note.text.includes('https://mcpemails.test/blog/what-is-an-app-password'));
  assert.ok(note.text.includes('full refund within 14 days of your first payment'));
  assert.ok(note.text.trimEnd().endsWith('Asgeir'));
  assertCleanCopy(note.text);
});

test('M2 note with no calls at all says the connector is not added yet', () => {
  const none = tpl.composeStuckNote({ firstName: null, paidAt: T0.toISOString(), totalCalls: 0, topErrorCodes: [], clientNames: [], inboxProviders: [] });
  assert.ok(none.text.startsWith('Hi,\n'));
  assert.ok(none.text.includes("hasn't been added to your AI app yet."));
  assert.ok(none.text.includes('There is no inbox connected yet.'));
  assert.ok(none.text.includes('/docs/clients'));
  const named = tpl.composeStuckNote({ firstName: null, paidAt: T0.toISOString(), totalCalls: 0, topErrorCodes: [], clientNames: ['Cursor'], inboxProviders: ['gmail'] });
  assert.ok(named.text.includes("hasn't been added to Cursor yet."));
  assert.ok(!named.text.includes('There is no inbox connected yet.'));
});

test('M2 unknown error codes are named so Asgeir can look them up', () => {
  assert.equal(tpl.explainErrorCode('weird_thing').plain, 'an error (code weird_thing)');
  assert.equal(tpl.explainErrorCode('AUTH_FAILED').plain, 'the mail server rejected the password');
});

test('M2 mailto link carries the note without adding headers', () => {
  const note = tpl.composeStuckNote({ firstName: null, paidAt: T0.toISOString(), ...DETAILS });
  const link = tpl.mailtoFor('owner@example.test', note);
  assert.ok(link.startsWith('mailto:owner%40example.test?subject=Your%20MCPEmails%20setup&body='));
  assert.ok(!/[\r\n]/.test(link));
});

// ---------------------------------------------------------------------------
// Draft writer (pure parts)
// ---------------------------------------------------------------------------

test('buildDraftMessage writes a plain-text RFC 5322 message', () => {
  const msg = draftMod.buildDraftMessage({
    from: 'founder@example.test',
    to: 'owner@example.test',
    subject: 'Your MCPEmails setup',
    text: 'Hi,\n\nLine with æøå.',
    date: new Date('2026-11-05T10:00:00Z'),
    messageId: 'abc@mcpemails.com',
  });
  const [head, body] = msg.split('\r\n\r\n');
  assert.ok(head.includes('From: founder@example.test'));
  assert.ok(head.includes('To: owner@example.test'));
  assert.ok(head.includes('Subject: Your MCPEmails setup'));
  assert.ok(head.includes('Message-ID: <abc@mcpemails.com>'));
  assert.ok(head.includes('Content-Transfer-Encoding: base64'));
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hi,\r\n\r\nLine with æøå.');
});

test('buildDraftMessage refuses header injection', () => {
  assert.throws(() =>
    draftMod.buildDraftMessage({
      from: 'a@example.test',
      to: 'owner@example.test\r\nBcc: x@example.test',
      subject: 's',
      text: 't',
      date: new Date(),
      messageId: 'm@x',
    }),
  );
  assert.equal(draftMod.encodeHeader('Hei på deg'), `=?UTF-8?B?${Buffer.from('Hei på deg').toString('base64')}?=`);
});

test('pickDraftsMailbox prefers the \\Drafts attribute, then the name', () => {
  const box = (name: string, attributes: string[] = []) => ({ name, delimiter: '/', attributes });
  assert.equal(draftMod.pickDraftsMailbox([box('INBOX'), box('Kladder', ['\\Drafts'])]), 'Kladder');
  assert.equal(draftMod.pickDraftsMailbox([box('INBOX'), box('INBOX.Drafts')]), 'INBOX.Drafts');
  assert.equal(draftMod.pickDraftsMailbox([box('INBOX')]), 'Drafts');
});

test('firstThatWorks falls back to the internal notice and says why', async () => {
  const note = tpl.composeStuckNote({ firstName: null, paidAt: T0.toISOString(), ...DETAILS });
  const draft = { to: 'owner@example.test', note, workspaceId: WS, idempotencyKey: 'k' };
  const sent: OutgoingEmail[] = [];
  const notice = draftMod.createInternalNoticeWriter(async (e) => {
    sent.push(e);
    return { ok: true, id: 're_1' };
  }, 'founder@example.test');
  const writer = draftMod.firstThatWorks(async () => {
    throw new Error('APPEND NO: quota');
  }, notice);
  const result = await writer(draft);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.via.startsWith('internal_notice'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'founder@example.test', 'the notice only goes to our own mailbox');
  assert.ok(sent[0].text.includes('mailto:owner%40example.test'));
  assert.ok(sent[0].text.includes('Nothing has been sent to the customer.'));
  assert.equal(sent[0].idempotencyKey, 'k-notice');

  const allFail = draftMod.firstThatWorks(async () => ({ ok: false, reason: 'a' }), async () => ({ ok: false, reason: 'b' }));
  assert.deepEqual(await allFail(draft), { ok: false, reason: 'a; b' });
});

// ---------------------------------------------------------------------------
// Store helpers and the opt-out category
// ---------------------------------------------------------------------------

test('topCodes and activeDayCount', () => {
  assert.deepEqual(storeMod.topCodes(['b', 'a', null, 'b', 'c', 'a', 'b', 'd']), [
    { code: 'b', count: 3 },
    { code: 'a', count: 2 },
    { code: 'c', count: 1 },
  ]);
  const start = T0.getTime();
  const iso = (o: number) => new Date(start + o).toISOString();
  assert.equal(storeMod.activeDayCount([iso(1), iso(2 * HOUR), iso(DAY + 5), iso(6 * DAY + 1), iso(7 * DAY + 1), iso(-1)], start), 3);
});

test('activity_summary is a lifecycle category and the migration lets the database store it', () => {
  assert.ok((LIFECYCLE_CATEGORIES as readonly string[]).includes('activity_summary'));
  assert.equal(tpl.ACTIVITY_SUMMARY_CATEGORY, 'activity_summary');
  const sql = readMigration();
  const m = /CHECK \(unsubscribed_categories <@ ARRAY\[([^\]]+)\]/.exec(sql);
  assert.ok(m);
  const inSql = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual([...inSql].sort(), [...LIFECYCLE_CATEGORIES].sort());
});

test('the migration schedules the dispatcher the same way as the paywall one', () => {
  const sql = readMigration();
  assert.ok(sql.includes("'https://mcpemails.com/api/internal/first-30-days/dispatch'"));
  assert.ok(sql.includes("name = 'dispatch_secret'"));
  assert.ok(/cron\.schedule\(\s*'dispatch-first-30-days'/.test(sql));
});

function readMigration(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.resolve(here, '../../../../../supabase/migrations/20261024170000_first_30_days.sql'), 'utf8');
}
