// Run with: npm run test:inbox-alert
//
// Eligibility, break dating, the run (fake store) and the copy of the
// broken-inbox alert. Only reserved example domains appear below.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARM_ALERT,
  ARM_HOLDOUT,
  alertIdempotencyKey,
  firstAlertGate,
  guideSlugFor,
  guideUrl,
  inboxAlertMode,
  isProviderSideBreak,
  openBreakOutcome,
  proposedArm,
  providerLabel,
  resolveBreakStart,
  runInboxAlerts,
  type AlertEmailInput,
  type CandidateRow,
  type FunnelCategory,
  type FunnelStage,
  type InboxAlertArm,
  type InboxAlertStore,
  type InboxState,
  type LedgerRow,
  type NewLedgerRow,
} from './inbox-alert.ts';
import { alertCopy, composeInboxAlert } from './inbox-alert-templates.ts';
import { ACTIVATION_HELP_LOCALES } from '@/lib/email/activation-help-templates';
import { OUTLOOK_NO_MAILBOX_REASON } from '@/lib/email-providers/outlook-oauth';

const MARKER = (iso: string) =>
  `The mail server refused this mailbox's password. Reconnect this inbox to restore access. (Checked ${iso})`;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function cand(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    inboxId: 'ib-1',
    workspaceId: '11111111-2222-3333-4444-555555555555',
    ownerId: 'u-1',
    ownerEmail: 'owner@example.com',
    plan: 'personal',
    acquisitionLocale: null,
    emailAddress: 'me@example.com',
    provider: 'imap',
    service: 'generic',
    imapHost: 'imap.fastmail.com',
    inboxStatus: 'active',
    lastError: MARKER(hoursAgo(1)),
    errorRowAt: hoursAgo(1),
    firstAuthFailedAt: hoursAgo(30),
    lastAuthFailedAt: hoursAgo(1),
    lastSuccessAt: hoursAgo(40),
    lastClosedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test('mode: off unless on or dry_run', () => {
  assert.equal(inboxAlertMode({}), 'off');
  assert.equal(inboxAlertMode({ INBOX_ALERT_ENABLED: 'true' }), 'off');
  assert.equal(inboxAlertMode({ INBOX_ALERT_ENABLED: 'dry_run' }), 'dry_run');
  assert.equal(inboxAlertMode({ INBOX_ALERT_ENABLED: ' ON ' }), 'on');
});

test('provider-side: marker and token refusals count; Outlook no-mailbox, admin block and empty errors do not', () => {
  assert.equal(isProviderSideBreak({ provider: 'imap', inboxStatus: 'active', lastError: MARKER('2026-11-10T00:00:00.000Z') }), true);
  assert.equal(isProviderSideBreak({ provider: 'imap', inboxStatus: 'active', lastError: 'Sent copy failed' }), false);
  assert.equal(isProviderSideBreak({ provider: 'imap', inboxStatus: 'active', lastError: null }), false);
  assert.equal(isProviderSideBreak({ provider: 'gmail', inboxStatus: 'error', lastError: 'Google rejected the saved access.' }), true);
  assert.equal(isProviderSideBreak({ provider: 'outlook', inboxStatus: 'error', lastError: 'Outlook refresh token expired or revoked — reconnection required.' }), true);
  assert.equal(isProviderSideBreak({ provider: 'outlook', inboxStatus: 'error', lastError: OUTLOOK_NO_MAILBOX_REASON }), false);
  assert.equal(
    isProviderSideBreak({ provider: 'outlook', inboxStatus: 'error', lastError: 'Microsoft accepted the sign-in but refused access to this mailbox. An administrator...' }),
    false,
  );
  assert.equal(isProviderSideBreak({ provider: 'gmail', inboxStatus: 'error', lastError: null }), false);
  assert.equal(isProviderSideBreak({ provider: 'imap', inboxStatus: 'pending', lastError: MARKER('2026-11-10T00:00:00.000Z') }), false);
});

test('break start: open ledger row wins until a success comes after it', () => {
  const open = { breakStartedAt: hoursAgo(35) };
  assert.deepEqual(resolveBreakStart(cand(), open), { at: hoursAgo(35), source: 'ledger' });
  assert.deepEqual(resolveBreakStart(cand({ lastSuccessAt: hoursAgo(32) }), open), { at: hoursAgo(30), source: 'activity' });
});

test('break start: activity first, then the error row, never a row older than the last closed break', () => {
  assert.equal(resolveBreakStart(cand(), null)?.source, 'activity');
  assert.deepEqual(resolveBreakStart(cand({ firstAuthFailedAt: null, errorRowAt: hoursAgo(26) }), null), { at: hoursAgo(26), source: 'row' });
  assert.equal(resolveBreakStart(cand({ firstAuthFailedAt: null, errorRowAt: hoursAgo(26), lastClosedAt: hoursAgo(20) }), null), null);
  assert.equal(resolveBreakStart(cand({ firstAuthFailedAt: null, errorRowAt: null }), null), null);
});

test('first alert gate: 24 hours, no success since, provider-side only', () => {
  const c = cand();
  assert.equal(firstAlertGate(c, resolveBreakStart(c, null), NOW), null);
  const young = cand({ firstAuthFailedAt: hoursAgo(23) });
  assert.equal(firstAlertGate(young, resolveBreakStart(young, null), NOW), 'under_24h');
  assert.equal(firstAlertGate(c, { at: hoursAgo(30) }, NOW), null);
  assert.equal(firstAlertGate(cand({ lastSuccessAt: hoursAgo(10) }), { at: hoursAgo(30) }, NOW), 'success_since_break');
  assert.equal(firstAlertGate(cand({ lastError: 'timeout' }), { at: hoursAgo(30) }, NOW), 'not_provider_side');
  assert.equal(firstAlertGate(c, null, NOW), 'no_break_start');
});

test('open break outcome: reconnected only when usable again; removed when deleted or parked', () => {
  const s = (over: Partial<InboxState>): InboxState => ({ provider: 'imap', status: 'active', lastError: null, deletedAt: null, parkedAt: null, ...over });
  assert.equal(openBreakOutcome(s({})), 'reconnected');
  assert.equal(openBreakOutcome(s({ lastError: MARKER('2026-11-10T00:00:00.000Z') })), null);
  assert.equal(openBreakOutcome(s({ status: 'error', lastError: 'x' })), null);
  assert.equal(openBreakOutcome(s({ deletedAt: hoursAgo(1) })), 'removed');
  assert.equal(openBreakOutcome(s({ parkedAt: hoursAgo(1) })), 'removed');
  assert.equal(openBreakOutcome(null), 'removed');
});

test('guide and provider name', () => {
  assert.equal(guideSlugFor({ provider: 'gmail', service: null, imapHost: null }), 'gmail');
  assert.equal(guideSlugFor({ provider: 'outlook', service: null, imapHost: null }), 'outlook');
  assert.equal(guideSlugFor({ provider: 'imap', service: 'icloud', imapHost: 'imap.mail.me.com' }), 'icloud');
  assert.equal(guideSlugFor({ provider: 'imap', service: 'generic', imapHost: 'imap.fastmail.com' }), 'fastmail');
  assert.equal(guideSlugFor({ provider: 'imap', service: 'generic', imapHost: 'mail.example.com' }), null);
  assert.equal(providerLabel({ provider: 'imap', service: 'generic', imapHost: 'mail.example.com' }), 'mail.example.com');
  assert.equal(providerLabel({ provider: 'gmail', service: null, imapHost: null }), 'Gmail');
  assert.equal(guideUrl('gmail', 'en', 'https://mcpemails.com'), 'https://mcpemails.com/connect/gmail');
  assert.equal(guideUrl('gmail', 'nb', 'https://mcpemails.com'), 'https://mcpemails.com/nb/connect/gmail');
  assert.equal(guideUrl(null, 'en', 'https://mcpemails.com'), null);
});

test('arm proposal is deterministic and both arms occur', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const arms = new Set(ids.map(proposedArm));
  assert.equal(proposedArm(ids[7]), proposedArm(ids[7]));
  assert.deepEqual([...arms].sort(), [ARM_ALERT, ARM_HOLDOUT].sort());
});

// ---------------------------------------------------------------------------
// The run, against a fake store
// ---------------------------------------------------------------------------

class FakeStore implements InboxAlertStore {
  rows: (LedgerRow & { provider: string })[] = [];
  funnel: { workspaceId: string; stage: FunnelStage; category: FunnelCategory }[] = [];
  assigned: string[] = [];
  nextId = 1;
  candidates: CandidateRow[];
  arm: InboxAlertArm | null;
  states: Map<string, InboxState>;
  constructor(candidates: CandidateRow[], arm: InboxAlertArm | null = ARM_ALERT, states = new Map<string, InboxState>()) {
    this.candidates = candidates;
    this.arm = arm;
    this.states = states;
  }
  async listCandidates() { return this.candidates; }
  async listOpenLedger() { return this.rows.filter((r) => r.closedAt === null); }
  /** An explicit state wins; otherwise the inbox is as its candidate row says (still broken). */
  async loadInboxStates(ids: string[]) {
    const out = new Map<string, InboxState>();
    for (const id of ids) {
      const explicit = this.states.get(id);
      const c = this.candidates.find((x) => x.inboxId === id);
      if (explicit) out.set(id, explicit);
      else if (c) out.set(id, { provider: c.provider, status: c.inboxStatus, lastError: c.lastError, deletedAt: null, parkedAt: null });
    }
    return out;
  }
  async assignArm(workspaceId: string) {
    this.assigned.push(workspaceId);
    return this.arm;
  }
  async insertRow(row: NewLedgerRow) {
    if (this.rows.some((r) => r.inboxId === row.inboxId && r.breakStartedAt === row.breakStartedAt && r.phase === row.phase)) return null;
    const created: LedgerRow & { provider: string } = {
      id: this.nextId++, inboxId: row.inboxId, workspaceId: row.workspaceId, breakStartedAt: row.breakStartedAt,
      phase: row.phase, arm: row.arm, status: row.status, attempts: row.status === 'claimed' ? 1 : 0,
      createdAt: NOW.toISOString(), sentAt: null, closedAt: null, provider: row.provider,
    };
    this.rows.push(created);
    return created;
  }
  async reclaimRow(id: number, attempts: number) {
    const r = this.rows.find((x) => x.id === id && x.attempts === attempts);
    if (!r) return false;
    r.status = 'claimed';
    r.attempts += 1;
    return true;
  }
  async finishRow(id: number, outcome: { status: 'sent'; providerMessageId: string | null } | { status: 'failed'; detail: string }) {
    const r = this.rows.find((x) => x.id === id)!;
    r.status = outcome.status;
    if (outcome.status === 'sent') r.sentAt = NOW.toISOString();
  }
  async closeBreak(inboxId: string, breakStartedAt: string, _reason: 'reconnected' | 'removed', at: Date) {
    for (const r of this.rows) if (r.inboxId === inboxId && r.breakStartedAt === breakStartedAt && !r.closedAt) r.closedAt = at.toISOString();
  }
  async recordFunnel(workspaceId: string, stage: FunnelStage, category: FunnelCategory) {
    this.funnel.push({ workspaceId, stage, category });
  }
}

function sender(ok = true) {
  const sent: AlertEmailInput[] = [];
  const send = async (input: AlertEmailInput) => {
    sent.push(input);
    return ok ? { ok: true as const, id: 'msg-1' } : { ok: false as const, reason: 'boom' };
  };
  return { sent, send };
}

test('dry run: reports the first alert, writes nothing, assigns nobody, sends nothing', async () => {
  const store = new FakeStore([cand()]);
  const { sent, send } = sender();
  const report = await runInboxAlerts({ mode: 'dry_run', store, send, now: NOW });
  assert.equal(report.counts.would_first, 1);
  assert.equal(store.rows.length, 0);
  assert.equal(store.assigned.length, 0);
  assert.equal(store.funnel.length, 0);
  assert.equal(sent.length, 0);
});

test('alert arm: phase 1 once per break, funnel row, idempotency key per break and phase', async () => {
  const store = new FakeStore([cand()]);
  const { sent, send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(sent[0].inboxAddress, 'me@example.com');
  assert.equal(sent[0].providerName, 'Fastmail');
  assert.equal(sent[0].idempotencyKey, alertIdempotencyKey('ib-1', hoursAgo(30), 1));
  assert.deepEqual(store.funnel.map((f) => `${f.stage}:${f.category}`), ['inbox_alert_sent:alert_1']);
  assert.equal(store.rows[0].status, 'sent');
});

test('holdout arm: nothing sent, holdout row and funnel row at the same moment', async () => {
  const store = new FakeStore([cand()], ARM_HOLDOUT);
  const { sent, send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  assert.equal(sent.length, 0);
  assert.equal(store.rows[0].status, 'holdout');
  assert.deepEqual(store.funnel.map((f) => `${f.stage}:${f.category}`), ['inbox_alert_holdout:alert_1']);
});

test('experiment unreadable: fails closed', async () => {
  const store = new FakeStore([cand()], null);
  const { sent, send } = sender();
  const report = await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  assert.equal(sent.length, 0);
  assert.equal(store.rows.length, 0);
  assert.equal(report.counts.skip_experiment_unavailable, 1);
});

test('under 24 hours: no alert, no assignment', async () => {
  const store = new FakeStore([cand({ firstAuthFailedAt: hoursAgo(5) })]);
  const { sent, send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  assert.equal(sent.length, 0);
  assert.equal(store.assigned.length, 0);
});

test('phase 2: five days after phase 1 was sent, only while the break is open', async () => {
  const store = new FakeStore([cand()]);
  const { sent, send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  const fourDays = new Date(NOW.getTime() + 4 * 86400_000);
  await runInboxAlerts({ mode: 'on', store, send, now: fourDays });
  assert.equal(sent.length, 1);
  const sixDays = new Date(NOW.getTime() + 6 * 86400_000);
  await runInboxAlerts({ mode: 'on', store, send, now: sixDays });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].phase, 2);
  assert.equal(sent[1].idempotencyKey, alertIdempotencyKey('ib-1', hoursAgo(30), 2));
  await runInboxAlerts({ mode: 'on', store, send, now: new Date(NOW.getTime() + 12 * 86400_000) });
  assert.equal(sent.length, 2, 'never a third');
});

test('reconnected: break closed, inbox_reconnected logged for the arm, no phase 2', async () => {
  const store = new FakeStore([cand()], ARM_HOLDOUT);
  const { sent, send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  store.candidates = [];
  store.states.set('ib-1', { provider: 'imap', status: 'active', lastError: null, deletedAt: null, parkedAt: null });
  const report = await runInboxAlerts({ mode: 'on', store, send, now: new Date(NOW.getTime() + 2 * 86400_000) });
  assert.equal(report.counts.reconnected, 1);
  assert.ok(store.rows.every((r) => r.closedAt !== null));
  assert.deepEqual(store.funnel.map((f) => `${f.stage}:${f.category}`), ['inbox_alert_holdout:alert_1', 'inbox_reconnected:holdout']);
  assert.equal(sent.length, 0);
});

test('deleted inbox: break closed as removed, no inbox_reconnected', async () => {
  const store = new FakeStore([cand()]);
  const { send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  store.candidates = [];
  store.states.set('ib-1', { provider: 'imap', status: 'active', lastError: null, deletedAt: hoursAgo(1), parkedAt: null });
  const report = await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  assert.equal(report.counts.removed, 1);
  assert.equal(store.funnel.some((f) => f.stage === 'inbox_reconnected'), false);
});

test('reconnect then a new break: a new phase 1 for the new break start', async () => {
  const store = new FakeStore([cand()]);
  const { sent, send } = sender();
  await runInboxAlerts({ mode: 'on', store, send, now: NOW });
  // A success after the first break, then refused again 30 hours ago... from a later now.
  const later = new Date(NOW.getTime() + 10 * 86400_000);
  const at = (h: number) => new Date(later.getTime() - h * 3600_000).toISOString();
  store.candidates = [cand({ lastSuccessAt: at(60), firstAuthFailedAt: at(30) })];
  store.states.set('ib-1', { provider: 'imap', status: 'active', lastError: MARKER(at(1)), deletedAt: null, parkedAt: null });
  const report = await runInboxAlerts({ mode: 'on', store, send, now: later });
  assert.equal(report.counts.reconnected, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].phase, 1);
  assert.equal(sent[1].brokenSince, at(30));
});

test('failed send: retried after an hour, at most three attempts', async () => {
  const store = new FakeStore([cand()]);
  const failing = sender(false);
  await runInboxAlerts({ mode: 'on', store, send: failing.send, now: NOW });
  await runInboxAlerts({ mode: 'on', store, send: failing.send, now: NOW });
  assert.equal(failing.sent.length, 1, 'no retry inside the hour');
  for (let h = 2; h < 8; h += 1) {
    await runInboxAlerts({ mode: 'on', store, send: failing.send, now: new Date(NOW.getTime() + h * 3600_000) });
  }
  assert.equal(failing.sent.length, 3);
  assert.equal(new Set(failing.sent.map((s) => s.idempotencyKey)).size, 1);
});

test('send cap per run', async () => {
  const cands = Array.from({ length: 5 }, (_, i) => cand({ inboxId: `ib-${i}` }));
  const store = new FakeStore(cands);
  const { sent, send } = sender();
  const report = await runInboxAlerts({ mode: 'on', store, send, now: NOW, maxSends: 2 });
  assert.equal(sent.length, 2);
  assert.equal(report.truncated, true);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('copy: names the inbox, provider, links, and no banned wording in any locale', () => {
  for (const locale of ACTIVATION_HELP_LOCALES) {
    for (const phase of [1, 2] as const) {
      const email = composeInboxAlert({
        phase,
        locale,
        inboxAddress: 'me@example.com',
        providerName: 'Fastmail',
        guideSlug: 'fastmail',
        brokenSince: '2026-11-09T08:00:00.000Z',
        baseUrl: 'https://mcpemails.com/',
      });
      const all = `${email.subject}\n${email.text}\n${email.html}`;
      assert.ok(email.subject.includes('me@example.com'), `${locale}: subject names the inbox`);
      assert.ok(email.text.includes('Fastmail'), `${locale}: names the provider`);
      assert.ok(email.text.includes('https://mcpemails.com/dashboard/inboxes'), `${locale}: reconnect link`);
      assert.ok(email.text.includes('/connect/fastmail'), `${locale}: guide link`);
      assert.ok(email.text.includes('MCPEmails'), `${locale}: product name`);
      assert.equal(/—/.test(all), false, `${locale}: no em dash`);
      assert.equal(/MCP Emails|\$\d|price|upgrade|30 days/i.test(all), false, `${locale}: no price, upsell or wrong name`);
      const c = alertCopy(email.locale);
      for (const s of [c.hi, c.why, c.action, c.button, c.help]) assert.equal(/[<>]/.test(s), false, `${locale}: no angle brackets`);
    }
  }
});

test('copy: unknown locale falls back to English; no guide line without a guide', () => {
  const email = composeInboxAlert({
    phase: 1,
    locale: 'xx',
    inboxAddress: 'me@example.com',
    providerName: 'mail.example.com',
    guideSlug: null,
    brokenSince: '2026-11-09T08:00:00.000Z',
    baseUrl: 'https://mcpemails.com',
  });
  assert.equal(email.locale, 'en');
  assert.equal(email.guideUrl, null);
  assert.equal(email.text.includes('Step-by-step'), false);
  assert.ok(email.text.includes('9 November 2026'));
  assert.ok(email.text.includes('password was changed'));
});

test('copy: the address is escaped in HTML', () => {
  const email = composeInboxAlert({
    phase: 1,
    locale: 'en',
    inboxAddress: '"a<b>"@example.com',
    providerName: 'X',
    guideSlug: null,
    brokenSince: '2026-11-09T08:00:00.000Z',
    baseUrl: 'https://mcpemails.com',
  });
  assert.equal(email.html.includes('<b>'), false);
});
