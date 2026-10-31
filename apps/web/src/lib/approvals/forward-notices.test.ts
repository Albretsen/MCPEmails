// ---------------------------------------------------------------------------
// The emails about rule forwards waiting for approval, and the counts of them.
// The claim itself is proven against Postgres in
// supabase/tests/forward_approval_notices.sql.
//
// Run with: npm run test:forward-notices
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const {
  composeForwardNotice,
  dispatchForwardNotices,
  cleanRuleName,
  formatDeadline,
  NOTICE_MAX_ATTEMPTS,
  NOTICE_LOOP_GUARD_HEADER,
} = await import('./forward-notices.ts');
const { waitingApprovals, waitingForRule, waitingLabel, APPROVAL_LIST_LIMIT } = await import('./waiting.ts');
const { SKIPPED_ID_PREFIX } = await import('../email/resend.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */

const RULE = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const DEADLINE = '2026-11-07T10:00:00.000Z';

const facts = (over: Record<string, unknown> = {}) => ({
  kind: 'queued' as const,
  ruleId: RULE,
  ruleName: 'Invoices',
  count: 5,
  addresses: ['books@example.test'],
  deadline: DEADLINE,
  ...over,
});

test('the queued email states rule, count, address, deadline and the filtered link', () => {
  const email = composeForwardNotice(facts(), TOKEN);
  assert.equal(email.subject, '5 forwards need your approval');
  for (const part of [email.text, email.html]) {
    assert.ok(part.includes('Invoices'));
    assert.ok(part.includes('5 forwards'));
    assert.ok(part.includes('books@example.test'));
    assert.ok(part.includes('7 November 2026'));
    assert.ok(part.includes(`/dashboard/approvals?rule=${RULE}`));
    assert.ok(part.includes('c=approval_notices'));
  }
});

test('the reminder says it expires, in the singular when there is one', () => {
  const email = composeForwardNotice(facts({ kind: 'reminder', count: 1 }), TOKEN);
  assert.equal(email.subject, '1 forward expires soon');
  assert.match(email.text, /Decide by 7 November 2026/);
});

test('the subject never names the rule, so a rule cannot match its own notice', () => {
  const email = composeForwardNotice(facts({ ruleName: 'Invoices' }), TOKEN);
  assert.ok(!email.subject.includes('Invoices'));
});

test('the loop guard header is the one the engine refuses', async () => {
  const { readFileSync } = await import('node:fs');
  const engine = readFileSync(new URL('../../../../../supabase/functions/mcp-server/triage-engine.ts', import.meta.url), 'utf8');
  assert.ok(engine.includes(`RULE_FORWARD_HEADER = "${NOTICE_LOOP_GUARD_HEADER}"`));
});

test('a rule name stays on one line and bounded', () => {
  assert.equal(cleanRuleName('a\r\nBcc: x@example.test'), 'a Bcc: x@example.test');
  assert.ok(cleanRuleName('x'.repeat(300)).length <= 80);
});

test('a rule name is escaped in the html', () => {
  const email = composeForwardNotice(facts({ ruleName: '<img src=x>' }), TOKEN);
  assert.ok(!email.html.includes('<img src=x>'));
});

test('a long address list is cut, not dropped', () => {
  const addresses = Array.from({ length: 7 }, (_, i) => `a${i}@example.test`);
  const email = composeForwardNotice(facts({ addresses }), TOKEN);
  assert.ok(email.text.includes('and 2 more'));
});

test('the deadline is labelled UTC', () => {
  assert.match(formatDeadline(DEADLINE), /UTC$/);
});

function harness(over: Record<string, any> = {}) {
  const state = {
    finished: [] as any[],
    events: [] as any[],
    sent: [] as any[],
  };
  const store: any = {
    claim: async () => over.notices ?? [{ id: 'n1', workspace_id: 'w1', triage_rule_id: RULE, kind: 'queued', attempts: 1 }],
    ruleName: async () => ('ruleName' in over ? over.ruleName : 'Invoices'),
    waiting: async () => ('waiting' in over ? over.waiting : { count: 5, addresses: ['books@example.test'], deadline: DEADLINE }),
    recipients: async () => over.recipients ?? [
      { userId: 'u1', email: 'owner@example.test', unsubscribeToken: TOKEN },
      { userId: 'u2', email: 'admin@example.test', unsubscribeToken: TOKEN },
    ],
    finish: async (id: string, outcome: any) => { state.finished.push({ id, ...outcome }); },
    logEvent: async (event: any) => { state.events.push(event); },
  };
  const send: any = async (email: any) => {
    state.sent.push(email);
    return over.send ? over.send(email) : { ok: true, id: 'resend-1' };
  };
  return { store, send, state };
}

test('one notice mails every owner and admin once, and writes one system event', async () => {
  const { store, send, state } = harness();
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.sent, 1);
  assert.equal(state.sent.length, 2);
  assert.deepEqual(state.finished.map((f) => f.status), ['sent']);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].payload.delivered, 2);
  assert.equal(state.events[0].payload.waiting, 5);
});

test('the system event never carries an address', async () => {
  const { store, send, state } = harness();
  await dispatchForwardNotices(store, send);
  assert.ok(!JSON.stringify(state.events).includes('@'));
});

test('the idempotency key differs per person and holds per notice', async () => {
  const { store, send, state } = harness();
  await dispatchForwardNotices(store, send);
  assert.equal(state.sent[0].idempotencyKey, 'forward-notice-n1-u1');
  assert.equal(state.sent[1].idempotencyKey, 'forward-notice-n1-u2');
});

test('nothing still waiting: no email, no event', async () => {
  const { store, send, state } = harness({ waiting: null });
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.cancelled, 1);
  assert.equal(state.sent.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.finished[0].error, 'nothing_waiting');
});

test('everyone opted out: no email', async () => {
  const { store, send, state } = harness({ recipients: [] });
  await dispatchForwardNotices(store, send);
  assert.equal(state.sent.length, 0);
  assert.equal(state.finished[0].error, 'no_recipients');
});

test('a refused send goes back in the queue and does not throw', async () => {
  const { store, send, state } = harness({ send: () => ({ ok: false, reason: 'rate_limited' }) });
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.retried, 1);
  assert.equal(state.finished[0].status, 'pending');
  assert.equal(state.events.length, 0);
});

test('the last attempt ends as failed, with an event', async () => {
  const { store, send, state } = harness({
    notices: [{ id: 'n1', workspace_id: 'w1', triage_rule_id: RULE, kind: 'queued', attempts: NOTICE_MAX_ATTEMPTS }],
    send: () => ({ ok: false, reason: 'rate_limited' }),
  });
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.failed, 1);
  assert.equal(state.finished[0].status, 'failed');
  assert.equal(state.events[0].status, 'failed');
});

test('a store that throws stops one notice, not the batch', async () => {
  const notices = [
    { id: 'n1', workspace_id: 'w1', triage_rule_id: RULE, kind: 'queued', attempts: 1 },
    { id: 'n2', workspace_id: 'w2', triage_rule_id: RULE, kind: 'queued', attempts: 1 },
  ];
  const { store, send, state } = harness({ notices });
  let calls = 0;
  const realWaiting = store.waiting;
  store.waiting = async () => {
    calls += 1;
    if (calls === 1) throw new Error('db down');
    return realWaiting();
  };
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.retried, 1);
  assert.equal(summary.sent, 1);
  assert.deepEqual(state.finished.map((f) => f.id), ['n2']);
});

test('a claim that fails reports nothing and does not throw', async () => {
  const { store, send } = harness();
  store.claim = async () => { throw new Error('db down'); };
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.claimed, 0);
});

test('a staging allowlist skip is recorded as skipped, not delivered', async () => {
  const { store, send, state } = harness({ send: () => ({ ok: true, id: `${SKIPPED_ID_PREFIX}-1` }) });
  await dispatchForwardNotices(store, send);
  assert.equal(state.events[0].payload.skipped, 2);
  assert.equal(state.events[0].payload.delivered, 0);
});

const NOW = Date.parse('2026-11-01T12:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  status: 'pending',
  created_at: '2026-11-01T11:00:00Z',
  expires_at: '2026-11-02T11:00:00Z',
  rule_id: RULE,
  ...over,
});

test('expired rows do not count', () => {
  const rows = [row(), row({ expires_at: '2026-11-01T11:59:00Z' })];
  assert.equal(waitingApprovals(rows, NOW).length, 1);
});

test('a row with no expiry lasts 24 hours from creation', () => {
  assert.equal(waitingApprovals([row({ expires_at: null })], NOW).length, 1);
  assert.equal(waitingApprovals([row({ expires_at: null, created_at: '2026-10-30T00:00:00Z' })], NOW).length, 0);
});

test('a decided row does not count', () => {
  assert.equal(waitingApprovals([row({ status: 'approved' })], NOW).length, 0);
});

test('the rule count takes only that rule', () => {
  const rows = [row(), row({ rule_id: 'other' }), row({ rule_id: null })];
  assert.equal(waitingForRule(rows, RULE, NOW).length, 1);
});

test('the label is hidden at zero and honest at the list limit', () => {
  assert.equal(waitingLabel(0, 0), undefined);
  assert.equal(waitingLabel(3, 3), '3');
  assert.equal(waitingLabel(APPROVAL_LIST_LIMIT, APPROVAL_LIST_LIMIT), `${APPROVAL_LIST_LIMIT}+`);
});
