import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertGmailOAuthCapClosed,
  decideGmailOAuthAccess,
  decideGmailOAuthCap,
  GMAIL_OAUTH_CAP_EVENT,
  GMAIL_OAUTH_RESERVE,
  GMAIL_OAUTH_USER_CAP,
  loadGmailOAuthCapState,
} from './gmail-oauth-gate.ts';

test('the cap closes once fewer than the reserve remain', () => {
  assert.equal(GMAIL_OAUTH_USER_CAP, 100);
  assert.equal(GMAIL_OAUTH_RESERVE, 5);
  assert.equal(decideGmailOAuthCap(94).closed, false);
  assert.equal(decideGmailOAuthCap(95).closed, false);
  assert.equal(decideGmailOAuthCap(95).remaining, 5);
  assert.equal(decideGmailOAuthCap(96).closed, true);
  assert.equal(decideGmailOAuthCap(100).closed, true);
  assert.equal(decideGmailOAuthCap(130).remaining, 0);
});

test('an unknown count closes the cap', () => {
  assert.equal(decideGmailOAuthCap(null).closed, true);
  assert.equal(decideGmailOAuthCap(Number.NaN).closed, true);
});

test('only Pro (solo) and Business (pro) may start a new Gmail sign-in', () => {
  for (const plan of ['free', 'personal', null, 'enterprise', '']) {
    const access = decideGmailOAuthAccess({ plan, capClosed: false });
    assert.equal(access.allowed, false, String(plan));
    assert.equal(access.refusal, 'plan');
  }
  for (const plan of ['solo', 'pro']) {
    assert.equal(decideGmailOAuthAccess({ plan, capClosed: false }).allowed, true, plan);
    const closed = decideGmailOAuthAccess({ plan, capClosed: true });
    assert.equal(closed.allowed, false);
    assert.equal(closed.refusal, 'cap');
  }
});

function fakeClient(opts: { summary?: unknown; summaryError?: boolean; recentAlerts?: number }) {
  const emitted: unknown[] = [];
  const client = {
    rpc: async (name: string, args?: unknown) => {
      if (name === 'gmail_oauth_cap_summary') {
        return opts.summaryError ? { data: null, error: { message: 'boom' } } : { data: opts.summary, error: null };
      }
      if (name === 'emit_system_event') {
        emitted.push(args);
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => {
      assert.equal(table, 'system_events');
      const chain = {
        select: () => chain,
        eq: (col: string, value: string) => {
          assert.equal(col, 'event_type');
          assert.equal(value, GMAIL_OAUTH_CAP_EVENT);
          return chain;
        },
        gte: async () => ({ count: opts.recentAlerts ?? 0, error: null }),
      };
      return chain;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, emitted };
}

test('the load uses the larger of our floor and the Console figure', async () => {
  const floorOnly = fakeClient({ summary: [{ distinct_ever: 95, google_reported_users: null }] });
  assert.deepEqual(await loadGmailOAuthCapState(floorOnly.client), { used: 95, remaining: 5, closed: false });
  const console = fakeClient({ summary: [{ distinct_ever: 95, google_reported_users: 98 }] });
  assert.deepEqual(await loadGmailOAuthCapState(console.client), { used: 98, remaining: 2, closed: true });
});

test('a failed load fails closed', async () => {
  const { client } = fakeClient({ summaryError: true });
  assert.equal((await loadGmailOAuthCapState(client)).closed, true);
  const empty = fakeClient({ summary: [] });
  assert.equal((await loadGmailOAuthCapState(empty.client)).closed, true);
});

test('the alert is sent once per window and never for an open or unknown cap', async () => {
  const first = fakeClient({ recentAlerts: 0 });
  assert.equal(await alertGmailOAuthCapClosed(first.client, decideGmailOAuthCap(97)), 'sent');
  assert.equal(first.emitted.length, 1);
  assert.deepEqual(first.emitted[0], {
    p_event_type: GMAIL_OAUTH_CAP_EVENT,
    p_payload: { used: 97, remaining: 3, cap: 100, reserve: 5 },
  });

  const repeat = fakeClient({ recentAlerts: 1 });
  assert.equal(await alertGmailOAuthCapClosed(repeat.client, decideGmailOAuthCap(97)), 'deduped');
  assert.equal(repeat.emitted.length, 0);

  const open = fakeClient({});
  assert.equal(await alertGmailOAuthCapClosed(open.client, decideGmailOAuthCap(90)), 'skipped');
  assert.equal(await alertGmailOAuthCapClosed(open.client, decideGmailOAuthCap(null)), 'skipped');
  assert.equal(open.emitted.length, 0);
});
