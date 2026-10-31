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
  composeReceipt,
  composeCoveragePaused,
  composeFailedNotice,
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

test('the reminder says how many expire soon and how many more wait', () => {
  const email = composeForwardNotice(facts({ kind: 'reminder', count: 7, expiringSoon: 1 }), TOKEN);
  assert.equal(email.subject, '1 forward expires soon, 6 more waiting');
  assert.match(email.text, /has 1 forward that expires soon, and 6 more waiting for approval/);
  assert.ok(!email.text.includes('still has 7'));
});

test('the reminder reads as before when all of them are near the deadline', () => {
  const email = composeForwardNotice(facts({ kind: 'reminder', count: 3, expiringSoon: 3 }), TOKEN);
  assert.equal(email.subject, '3 forwards expire soon');
});

test('a reminder with nothing near its deadline any more is cancelled', async () => {
  const { store, send, state } = harness({
    notices: [{ id: 'n1', workspace_id: 'w1', triage_rule_id: RULE, kind: 'reminder', attempts: 1 }],
    waiting: { count: 2, addresses: ['books@example.test'], deadline: DEADLINE, expiringSoon: 0 },
  });
  const summary = await dispatchForwardNotices(store, send);
  assert.equal(summary.cancelled, 1);
  assert.equal(state.sent.length, 0);
});

test('the address line is true for one address, several, and forwards that differ', () => {
  assert.match(composeForwardNotice(facts(), TOKEN).text, /They go to books@example\.test\./);
  assert.match(
    composeForwardNotice(facts({ count: 1, addresses: ['a@example.test', 'b@example.test'] }), TOKEN).text,
    /It goes to a@example\.test and b@example\.test\./,
  );
  assert.match(
    composeForwardNotice(facts({ addresses: ['a@example.test', 'b@example.test'], addressesVary: true }), TOKEN).text,
    /They go to different addresses: a@example\.test and b@example\.test\./,
  );
});

test('a receipt stops receipts only; the others stop the notices', () => {
  const receipt = composeReceipt({ ruleId: RULE, ruleName: 'Invoices', noApprovalRuleName: 'Trusted', count: 1, addresses: ['a@example.test'] }, TOKEN);
  assert.ok(receipt.unsubscribe.includes('c=approval_receipts'));
  assert.ok(receipt.text.includes('Stop these receipts'));
  assert.ok(receipt.text.includes('You still hear when forwards wait or fail'));
  assert.ok(composeForwardNotice(facts(), TOKEN).unsubscribe.includes('c=approval_notices'));
  assert.ok(composeCoveragePaused('Trusted', TOKEN).unsubscribe.includes('c=approval_notices'));
});

const failedFacts = (over: Record<string, unknown> = {}) => ({
  ruleId: RULE,
  ruleName: 'Invoices',
  count: 1,
  addresses: ['books@example.test'],
  canRetry: 1,
  mayHaveSent: 0,
  reason: 'recipient_refused' as const,
  ...over,
});

test('the failed email says what happened and what to do, with no rule name in the subject', () => {
  const email = composeFailedNotice(failedFacts(), TOKEN);
  assert.equal(email.subject, '1 forward could not be sent');
  for (const part of [email.text, email.html]) {
    assert.ok(part.includes('Invoices'));
    assert.ok(part.includes('books@example.test'));
    assert.ok(part.includes('The address was refused.'));
    assert.ok(part.includes('Forward again'));
    assert.ok(part.includes(`/dashboard/approvals?rule=${RULE}`));
    assert.ok(part.includes('c=approval_notices'));
  }
});

test('the failed email never offers again what may have gone out', () => {
  const maybe = composeFailedNotice(failedFacts({ canRetry: 0, mayHaveSent: 1, reason: 'may_have_sent' }), TOKEN);
  assert.ok(!maybe.text.includes('Forward again'));
  assert.match(maybe.text, /may have gone out/);
  const mixed = composeFailedNotice(failedFacts({ count: 3, canRetry: 2, mayHaveSent: 1, reason: null }), TOKEN);
  assert.match(mixed.text, /For 2 of them nothing was sent/);
  assert.match(mixed.text, /1 may have gone out/);
});

test('a receipt reads the receipts opt-out, every other notice the notices one', async () => {
  const seen: string[] = [];
  const { store, send } = harness({
    notices: [
      { id: 'n1', workspace_id: 'w1', triage_rule_id: RULE, kind: 'receipt', attempts: 1 },
      { id: 'n2', workspace_id: 'w1', triage_rule_id: RULE, kind: 'queued', attempts: 1 },
      { id: 'n3', workspace_id: 'w1', triage_rule_id: RULE, kind: 'failed', attempts: 1 },
    ],
  });
  store.receipt = async () => ({ count: 1, addresses: ['a@example.test'], noApprovalRuleName: null });
  store.failed = async () => ({ count: 1, addresses: ['a@example.test'], canRetry: 1, mayHaveSent: 0, reason: 'refused' });
  store.recipients = async (_workspace: string, category: string) => {
    seen.push(category);
    return [{ userId: 'u1', email: 'owner@example.test', unsubscribeToken: TOKEN }];
  };
  await dispatchForwardNotices(store, send);
  assert.deepEqual(seen, ['approval_receipts', 'approval_notices', 'approval_notices']);
});

test('a failed notice whose rows are gone is cancelled', async () => {
  const { store, send, state } = harness({ notices: [{ id: 'n1', workspace_id: 'w1', triage_rule_id: RULE, kind: 'failed', attempts: 1 }] });
  store.failed = async () => null;
  assert.equal((await dispatchForwardNotices(store, send)).cancelled, 1);
  assert.equal(state.sent.length, 0);
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

test('a receipt states count, address, rule and the run log, and what remains if you stop them', () => {
  const email = composeReceipt({
    ruleId: RULE,
    ruleName: 'Invoices',
    noApprovalRuleName: 'Bookkeeping',
    count: 3,
    addresses: ['books@example.test'],
  }, TOKEN);
  assert.equal(email.subject, '3 forwards sent without approval');
  assert.ok(!email.subject.includes('Invoices'), 'a rule can not match its own receipt by subject');
  for (const part of [email.text, email.html]) {
    assert.ok(part.includes('Invoices'));
    assert.ok(part.includes('Bookkeeping'));
    assert.ok(part.includes('books@example.test'));
    assert.ok(part.includes(`/dashboard/automations?runs=${RULE}`));
    assert.ok(part.includes('c=approval_receipts'));
    assert.ok(part.includes('the run log on the Automations page is the record'));
  }
});

test('a paused rule says what happens to the mail and how to resume', () => {
  const email = composeCoveragePaused('Bookkeeping', TOKEN);
  assert.ok(email.text.includes('Bookkeeping'));
  assert.ok(email.text.includes('wait for approval'));
  assert.ok(email.text.includes('switch it off and on'));
});

function receiptStore(over: Record<string, unknown>) {
  const finished: unknown[] = [];
  const store: any = {
    claim: async () => [over],
    ruleName: async () => 'Invoices',
    waiting: async () => { throw new Error('a receipt does not read the waiting list'); },
    receipt: async () => ({ count: 2, addresses: ['books@example.test'], noApprovalRuleName: 'Bookkeeping' }),
    noApprovalRuleName: async () => 'Bookkeeping',
    recipients: async () => [{ userId: 'u1', email: 'owner@example.test', unsubscribeToken: TOKEN }],
    finish: async (_id: string, outcome: unknown) => { finished.push(outcome); },
    logEvent: async () => {},
  };
  return { store, finished };
}

test('the dispatcher sends a receipt from the rows it counted', async () => {
  const { store, finished } = receiptStore({ id: 'n1', workspace_id: 'w', triage_rule_id: RULE, kind: 'receipt', attempts: 1 });
  const sent: any[] = [];
  const summary = await dispatchForwardNotices(store, async (email: any) => { sent.push(email); return { ok: true, id: 'r1' }; });
  assert.equal(summary.sent, 1);
  assert.equal(sent[0].subject, '2 forwards sent without approval');
  assert.deepEqual(finished, [{ status: 'sent' }]);
});

test('a receipt with nothing behind it is cancelled, and so is one for a removed rule', async () => {
  const empty = receiptStore({ id: 'n1', workspace_id: 'w', triage_rule_id: RULE, kind: 'receipt', attempts: 1 });
  empty.store.receipt = async () => null;
  const summary = await dispatchForwardNotices(empty.store, async () => { throw new Error('no send'); });
  assert.equal(summary.cancelled, 1);
  const gone = receiptStore({ id: 'n2', workspace_id: 'w', triage_rule_id: null, no_approval_rule_id: 'x', kind: 'coverage_paused', attempts: 1 });
  gone.store.noApprovalRuleName = async () => null;
  assert.equal((await dispatchForwardNotices(gone.store, async () => { throw new Error('no send'); })).cancelled, 1);
});

test('the paused notice goes out with no automation attached', async () => {
  const { store } = receiptStore({ id: 'n3', workspace_id: 'w', triage_rule_id: null, no_approval_rule_id: 'x', kind: 'coverage_paused', attempts: 1 });
  const sent: any[] = [];
  await dispatchForwardNotices(store, async (email: any) => { sent.push(email); return { ok: true, id: 'r1' }; });
  assert.equal(sent[0].subject, 'A no-approval rule has been paused');
});
